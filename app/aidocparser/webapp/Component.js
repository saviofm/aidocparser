sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/ui/Device"
], function (UIComponent, JSONModel, Device) {
  "use strict";

  return UIComponent.extend("aidocparser.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      // parse flow state
      this.setModel(new JSONModel({
        step: "drop",
        fileName: "", fileSize: 0, mimeType: "",
        parsedText: "", pageCount: 0, hasOcr: false, tokensUsed: 0,
        parseSource: "native",
        uploadMode: "parsed",
        parsedDestination: "sdm",
        selectedFolderId: null, selectedFolderName: "",
        busy: false, busyText: "", parseProgress: "",
        errorMessage: "", doneMessage: "", originalPresignedUrl: ""
      }), "app");

      // home/browse state
      this.setModel(new JSONModel({
        busy: false,
        currentPrefix: "",
        breadcrumbs: [],
        items: [], filteredItems: [],
        searchQuery: "", typeFilter: "all",
        selectedItems: [],
        docs: []
      }), "home");

      this.setModel(new JSONModel(Device), "device");

      this.getRouter().initialize();
    }
  });
});
