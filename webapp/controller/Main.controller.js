sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("aidocparser.controller.Main", {

    onInit: function () {
      this._folderDialog = null;
      this.getView().setModel(new JSONModel({ items: [] }), "folders");
    },

    // ── Helpers ─────────────────────────────────────────────────────────────

    _app: function () {
      return this.getOwnerComponent().getModel("app");
    },

    _set: function (props) {
      Object.entries(props).forEach(([k, v]) => this._app().setProperty("/" + k, v));
    },

    // ── Step: Drop ──────────────────────────────────────────────────────────

    onFileSelected: function (oEvent) {
      const oFile = oEvent.getParameter("files")[0];
      if (!oFile) return;

      this._selectedFile = oFile;
      this._set({
        fileName: oFile.name,
        fileSize: oFile.size,
        mimeType: oFile.type,
        step: "parsing",
        parseProgress: "Iniciando análise...",
        errorMessage: ""
      });

      this._parseFile(oFile);
    },

    // ── Parse ────────────────────────────────────────────────────────────────

    _parseFile: function (file) {
      const formData = new FormData();
      formData.append("file", file);

      this._set({ parseProgress: "Extraindo conteúdo..." });

      fetch("/api/parse", { method: "POST", body: formData })
        .then(res => {
          if (!res.ok) return res.json().then(e => Promise.reject(e.error || "Erro no servidor"));
          return res.json();
        })
        .then(data => {
          this._set({
            parsedText: data.parsedText,
            pageCount: data.pageCount,
            hasOcr: data.hasOcr,
            tokensUsed: data.tokensUsed,
            step: "preview",
            parseProgress: ""
          });
        })
        .catch(err => {
          this._set({ step: "drop", errorMessage: "Erro ao analisar: " + err });
        });
    },

    // ── Preview / Options ────────────────────────────────────────────────────

    onParsedDestChange: function (oEvent) {
      const key = oEvent.getParameter("selectedItem").getKey();
      this._set({ parsedDestination: key });
    },

    onUploadModeChange: function (oEvent) {
      const idx = oEvent.getParameter("selectedIndex");
      this._set({ uploadMode: idx === 0 ? "parsed" : "raw" });
    },

    // ── Folder Picker ────────────────────────────────────────────────────────

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
      const url = "/api/documents/folders?provider=sdm" + (parentId ? "&parentId=" + parentId : "");

      fetch(url)
        .then(r => r.json())
        .then(items => {
          this.getView().getModel("folders").setProperty("/items", items);
          this._set({ folderBusy: false });
        })
        .catch(() => this._set({ folderBusy: false }));
    },

    onFolderSelect: function (oEvent) {
      const ctx = oEvent.getParameter("listItem").getBindingContext("folders");
      const folder = ctx.getObject();
      this._set({ tempFolderId: folder.id, tempFolderName: folder.name });
    },

    onConfirmFolder: function () {
      const app = this._app().getData();
      this._set({
        selectedFolderId: app.tempFolderId,
        selectedFolderName: app.tempFolderName
      });
      this._folderDialog.close();
    },

    onCloseFolderPicker: function () {
      this._folderDialog.close();
    },

    // ── Upload ───────────────────────────────────────────────────────────────

    onUpload: function () {
      const app = this._app().getData();
      this._set({ busy: true, busyText: "Fazendo upload..." });

      const formData = new FormData();
      formData.append("parsedText", app.parsedText);
      formData.append("originalName", app.fileName);
      formData.append("mimeType", app.mimeType);
      formData.append("pageCount", String(app.pageCount));
      formData.append("hasOcr", String(app.hasOcr));
      formData.append("tokensUsed", String(app.tokensUsed));
      formData.append("parsedDestination", app.parsedDestination);
      formData.append("mode", app.uploadMode);

      if (app.parsedDestination === "sdm") {
        formData.append("folderId", app.selectedFolderId);
      }

      if (app.uploadMode === "raw" && this._selectedFile) {
        formData.append("file", this._selectedFile);
      } else if (app.uploadMode === "parsed" && this._selectedFile) {
        // original vai para S3 mesmo no modo parsed
        formData.append("file", this._selectedFile);
      }

      fetch("/api/upload", { method: "POST", body: formData })
        .then(res => {
          if (!res.ok) return res.json().then(e => Promise.reject(e.error || "Erro no upload"));
          return res.json();
        })
        .then(data => {
          const dest = app.parsedDestination === "sdm" ? "SDM" : "S3";
          this._set({
            busy: false,
            step: "done",
            doneMessage: data.parsedFileName + " → " + dest + (app.selectedFolderName ? " / " + app.selectedFolderName : ""),
            originalPresignedUrl: data.originalStorage?.presignedUrl || ""
          });
        })
        .catch(err => {
          this._set({ busy: false, errorMessage: "Erro no upload: " + err });
        });
    },

    // ── Reset ────────────────────────────────────────────────────────────────

    onReset: function () {
      this._selectedFile = null;
      this._set({
        step: "drop",
        fileName: "", fileSize: 0, mimeType: "",
        parsedText: "", pageCount: 0, hasOcr: false, tokensUsed: 0,
        uploadMode: "parsed", parsedDestination: "sdm",
        selectedFolderId: null, selectedFolderName: "",
        doneMessage: "", originalPresignedUrl: "",
        errorMessage: "", busy: false, busyText: ""
      });

      // reset file uploader
      const fu = this.byId("fileUploader");
      if (fu) fu.clear();
    },

    onCloseError: function () {
      this._set({ errorMessage: "" });
    }
  });
});
