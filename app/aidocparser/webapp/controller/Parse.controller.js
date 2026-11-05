sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("aidocparser.controller.Parse", {

    onInit: function () {
      this._folderDialog = null;
      this.getView().setModel(
        new sap.ui.model.json.JSONModel({ items: [] }),
        "folders"
      );
    },

    // ── Helpers ───────────────────────────────────────────────────────────────

    _app: function () { return this.getOwnerComponent().getModel("app"); },
    _set: function (props) {
      Object.entries(props).forEach(([k, v]) => this._app().setProperty("/" + k, v));
    },

    // ── Navigation ────────────────────────────────────────────────────────────

    onNavBack: function () {
      this.getOwnerComponent().getRouter().navTo("home");
    },

    // ── File selected ─────────────────────────────────────────────────────────

    onFileSelected: function (oEvent) {
      const oFile = oEvent.getParameter("files")[0];
      if (!oFile) return;

      this._selectedFile = oFile;
      this._set({
        fileName: oFile.name, fileSize: oFile.size, mimeType: oFile.type,
        step: "parsing", parseProgress: "Iniciando análise...", errorMessage: ""
      });
      this._parseFile(oFile);
    },

    // ── Parse (POST /api/parse/parseFile) ─────────────────────────────────────

    _parseFile: function (file) {
      const formData = new FormData();
      formData.append("file", file);
      this._set({ parseProgress: "Extraindo conteúdo..." });

      fetch("/api/parse/parseFile", { method: "POST", body: formData })
        .then(res => {
          if (!res.ok) return res.json().then(e => Promise.reject(e.error || "Erro no servidor"));
          return res.json();
        })
        .then(data => {
          this._set({
            parsedText:    data.parsedText,
            pageCount:     data.pageCount,
            hasOcr:        data.hasOcr,
            tokensUsed:    data.tokensUsed,
            parseSource:   data.parseSource || "native",
            step:          "preview",
            parseProgress: ""
          });
        })
        .catch(err => {
          this._set({ step: "drop", errorMessage: "Erro ao analisar: " + err });
        });
    },

    // ── Preview options ───────────────────────────────────────────────────────

    onParsedDestChange: function (oEvent) {
      this._set({ parsedDestination: oEvent.getParameter("selectedItem").getKey() });
    },

    onUploadModeChange: function (oEvent) {
      this._set({ uploadMode: oEvent.getParameter("selectedIndex") === 0 ? "parsed" : "raw" });
    },

    // ── Folder picker ─────────────────────────────────────────────────────────

    onOpenFolderPicker: function () {
      if (!this._folderDialog) {
        this._folderDialog = sap.ui.xmlfragment(
          this.getView().getId(),
          "aidocparser.view.FolderPickerDialog",
          this
        );
        this.getView().addDependent(this._folderDialog);
      }
      this._loadFolders(null);
      this._folderDialog.open();
    },

    _loadFolders: function (parentId) {
      this._set({ folderBusy: true });
      const url = "/api/parse/sdmFolders" + (parentId ? "?parentId=" + parentId : "");
      fetch(url)
        .then(r => r.json())
        .then(items => {
          this.getView().getModel("folders").setProperty("/items", items);
          this._set({ folderBusy: false });
        })
        .catch(() => this._set({ folderBusy: false }));
    },

    onFolderSelect: function (oEvent) {
      const folder = oEvent.getParameter("listItem").getBindingContext("folders").getObject();
      this._set({ tempFolderId: folder.id, tempFolderName: folder.name });
    },

    onConfirmFolder: function () {
      const app = this._app().getData();
      this._set({ selectedFolderId: app.tempFolderId, selectedFolderName: app.tempFolderName });
      this._folderDialog.close();
    },

    onCloseFolderPicker: function () {
      this._folderDialog.close();
    },

    // ── Upload (POST /api/parse/uploadDocument) ───────────────────────────────

    onUpload: function () {
      const app = this._app().getData();
      this._set({ busy: true, busyText: "Fazendo upload..." });

      const formData = new FormData();
      formData.append("parsedText",        app.parsedText);
      formData.append("originalName",      app.fileName);
      formData.append("mimeType",          app.mimeType);
      formData.append("pageCount",         String(app.pageCount));
      formData.append("hasOcr",            String(app.hasOcr));
      formData.append("tokensUsed",        String(app.tokensUsed));
      formData.append("parsedDestination", app.parsedDestination);
      formData.append("mode",              app.uploadMode);
      formData.append("file",              this._selectedFile);

      if (app.parsedDestination === "sdm") {
        formData.append("folderId", app.selectedFolderId);
      }

      fetch("/api/parse/uploadDocument", { method: "POST", body: formData })
        .then(res => {
          if (!res.ok) return res.json().then(e => Promise.reject(e.error || "Erro no upload"));
          return res.json();
        })
        .then(data => {
          const dest = app.parsedDestination === "sdm" ? "SDM" : "S3";
          const folder = app.selectedFolderName ? " / " + app.selectedFolderName : "";
          this._set({
            busy: false, step: "done",
            doneMessage: data.parsedFileName + " → " + dest + folder,
            originalPresignedUrl: data.originalStorage?.presignedUrl || ""
          });
        })
        .catch(err => {
          this._set({ busy: false, errorMessage: "Erro no upload: " + err });
        });
    },

    // ── Reset ─────────────────────────────────────────────────────────────────

    onReset: function () {
      this._selectedFile = null;
      this._set({
        step: "drop",
        fileName: "", fileSize: 0, mimeType: "",
        parsedText: "", pageCount: 0, hasOcr: false, tokensUsed: 0, parseSource: "native",
        uploadMode: "parsed", parsedDestination: "sdm",
        selectedFolderId: null, selectedFolderName: "",
        doneMessage: "", originalPresignedUrl: "",
        errorMessage: "", busy: false, busyText: "", parseProgress: ""
      });
      const fu = this.byId("fileUploader");
      if (fu) fu.clear();
    },

    onCloseError: function () {
      this._set({ errorMessage: "" });
    }
  });
});
