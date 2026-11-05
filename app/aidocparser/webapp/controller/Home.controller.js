sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("aidocparser.controller.Home", {

    onInit: function () {
      this.getOwnerComponent().getRouter()
        .getRoute("home").attachPatternMatched(this._onRouteMatched, this);
    },

    _onRouteMatched: function () {
      this._loadFiles("");
    },

    // ── Model helpers ─────────────────────────────────────────────────────────

    _home: function () { return this.getOwnerComponent().getModel("home"); },
    _set: function (props) {
      Object.entries(props).forEach(([k, v]) => this._home().setProperty("/" + k, v));
    },

    // ── Navigation ────────────────────────────────────────────────────────────

    onNavigateParse: function () {
      this.getOwnerComponent().getRouter().navTo("parse");
    },

    onTabBrowse: function () { /* já está aqui */ },

    // ── Load files from S3 ────────────────────────────────────────────────────

    _loadFiles: function (prefix) {
      this._set({ busy: true, currentPrefix: prefix });
      this._updateBreadcrumb(prefix);

      fetch("/api/files/listFiles?prefix=" + encodeURIComponent(prefix))
        .then(r => r.json())
        .then(items => {
          this._set({ items: items, busy: false });
          this._applyFilter();
        })
        .catch(err => {
          this._set({ busy: false });
          MessageToast.show("Erro ao carregar arquivos: " + err.message);
        });
    },

    _applyFilter: function () {
      const model   = this._home();
      const items   = model.getProperty("/items") || [];
      const query   = (model.getProperty("/searchQuery") || "").toLowerCase();
      const type    = model.getProperty("/typeFilter") || "all";

      const filtered = items.filter(item => {
        const matchName = !query || item.name.toLowerCase().includes(query);
        const matchType = type === "all" || item.itemType === type;
        return matchName && matchType;
      });
      this._set({ filteredItems: filtered });
    },

    // ── Breadcrumb ────────────────────────────────────────────────────────────

    _updateBreadcrumb: function (prefix) {
      const bc = this.byId("breadcrumbs");
      if (!bc) return;

      // destruir links anteriores
      bc.destroyLinks();
      bc.setCurrentLocationText("");

      if (!prefix) {
        bc.setCurrentLocationText("Raiz");
        return;
      }

      const parts = prefix.replace(/\/$/, "").split("/");
      parts.forEach((part, i) => {
        const partPrefix = parts.slice(0, i + 1).join("/") + "/";
        if (i < parts.length - 1) {
          const link = new sap.m.Link({ text: part, press: this._navToPrefix.bind(this, partPrefix) });
          bc.addLink(link);
        } else {
          bc.setCurrentLocationText(part);
        }
      });
    },

    _navToPrefix: function (prefix) {
      this._loadFiles(prefix);
    },

    // ── Item press (navegar pasta ou abrir arquivo) ───────────────────────────

    onItemPress: function (oEvent) {
      const ctx  = oEvent.getSource().getBindingContext("home");
      const item = ctx.getObject();
      if (item.isFolder) {
        this._loadFiles(item.objectKey);
      } else {
        this._downloadFile(item.objectKey, item.name);
      }
    },

    // ── Search / Filter ───────────────────────────────────────────────────────

    onSearch: function (oEvent) {
      this._set({ searchQuery: oEvent.getParameter("query") || oEvent.getParameter("newValue") || "" });
      this._applyFilter();
    },

    onTypeFilter: function (oEvent) {
      this._set({ typeFilter: oEvent.getParameter("item").getKey() });
      this._applyFilter();
    },

    // ── Selection ─────────────────────────────────────────────────────────────

    onSelectionChange: function (oEvent) {
      const table = this.byId("filesTable");
      const selected = table.getSelectedItems().map(item =>
        item.getBindingContext("home").getObject()
      );
      this._set({ selectedItems: selected });
    },

    // ── Create folder ─────────────────────────────────────────────────────────

    onCreateFolder: function () {
      const prefix = this._home().getProperty("/currentPrefix");
      MessageBox.prompt("Nome da nova pasta:", {
        title: "Criar pasta",
        onClose: (action, value) => {
          if (action !== MessageBox.Action.OK || !value) return;
          fetch("/api/files/createFolder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix, folderName: value })
          })
            .then(r => r.json())
            .then(() => { MessageToast.show("Pasta criada"); this._loadFiles(prefix); })
            .catch(err => MessageToast.show("Erro: " + err.message));
        }
      });
    },

    // ── Download ──────────────────────────────────────────────────────────────

    onDownload: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext("home");
      this._downloadFile(ctx.getProperty("objectKey"), ctx.getProperty("name"));
    },

    _downloadFile: function (key, name) {
      const a = document.createElement("a");
      a.href = "/api/files/download?key=" + encodeURIComponent(key);
      a.download = name;
      a.click();
    },

    // ── Presigned URL (para doc parseado) ────────────────────────────────────

    onCopyPresigned: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext("home");
      const key = ctx.getProperty("parsedRef");
      if (!key) return;

      fetch("/api/parse/presigned?key=" + encodeURIComponent(key))
        .then(r => r.json())
        .then(data => {
          navigator.clipboard.writeText(data.presignedUrl)
            .then(() => MessageToast.show("URL copiada para a área de transferência"))
            .catch(() => MessageToast.show(data.presignedUrl));
        })
        .catch(err => MessageToast.show("Erro ao gerar URL: " + err.message));
    },

    // ── Delete item (S3 direto — sem cascata de parsed) ──────────────────────

    onDeleteItem: function (oEvent) {
      const ctx  = oEvent.getSource().getBindingContext("home");
      const item = ctx.getObject();
      const prefix = this._home().getProperty("/currentPrefix");

      // Se tem docId → delete em cascata (original + parsed + DB)
      if (item.docId) {
        this._deleteDocument(item.docId, prefix);
        return;
      }

      MessageBox.confirm("Deletar \"" + item.name + "\"?", {
        title: "Confirmar exclusão",
        onClose: (action) => {
          if (action !== MessageBox.Action.OK) return;
          fetch("/api/files/deleteItem", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ objectKey: item.objectKey, itemType: item.itemType, recursive: true })
          })
            .then(() => { MessageToast.show("Deletado"); this._loadFiles(prefix); })
            .catch(err => MessageToast.show("Erro: " + err.message));
        }
      });
    },

    // ── Delete em cascata (docId → S3 original + SDM/S3 parsed + DB) ────────

    _deleteDocument: function (docId, prefix) {
      MessageBox.confirm("Isso vai deletar o arquivo original (S3) E o documento parseado (SDM/S3). Continuar?", {
        title: "Excluir documento completo",
        emphasizedAction: MessageBox.Action.OK,
        onClose: (action) => {
          if (action !== MessageBox.Action.OK) return;
          fetch("/api/parse/deleteDocument?docId=" + docId, { method: "DELETE" })
            .then(r => r.json())
            .then(data => {
              MessageToast.show(data.message || "Documento excluído");
              this._loadFiles(prefix);
            })
            .catch(err => MessageToast.show("Erro: " + err.message));
        }
      });
    },

    // ── Delete selecionados ───────────────────────────────────────────────────

    onDeleteSelected: function () {
      const selected = this._home().getProperty("/selectedItems");
      if (!selected.length) return;
      const prefix = this._home().getProperty("/currentPrefix");

      MessageBox.confirm("Deletar " + selected.length + " item(ns) selecionado(s)?", {
        title: "Confirmar exclusão múltipla",
        onClose: async (action) => {
          if (action !== MessageBox.Action.OK) return;
          for (const item of selected) {
            if (item.docId) {
              await fetch("/api/parse/deleteDocument?docId=" + item.docId, { method: "DELETE" }).catch(() => {});
            } else {
              await fetch("/api/files/deleteItem", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objectKey: item.objectKey, itemType: item.itemType, recursive: true })
              }).catch(() => {});
            }
          }
          MessageToast.show("Itens deletados");
          this._set({ selectedItems: [] });
          this._loadFiles(prefix);
        }
      });
    },

    // ── Formatters ────────────────────────────────────────────────────────────

    formatFileSize: function (bytes) {
      if (!bytes) return "";
      if (bytes < 1024)        return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    },

    formatDate: function (iso) {
      if (!iso) return "";
      return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    }
  });
});
