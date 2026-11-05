sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, JSONModel) {
  "use strict";

  return UIComponent.extend("aidocparser.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      // app state model
      this.setModel(new JSONModel({
        step: "drop",        // drop | parsing | preview | uploading | done
        fileName: "",
        fileSize: 0,
        mimeType: "",
        parsedText: "",
        pageCount: 0,
        hasOcr: false,
        tokensUsed: 0,
        uploadMode: "parsed",          // "parsed" | "raw"
        parsedDestination: "sdm",      // "sdm" | "s3"
        selectedFolderId: null,
        selectedFolderName: "",
        busy: false,
        errorMessage: ""
      }), "app");

      this.getRouter().initialize();
    }
  });
});
