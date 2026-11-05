/**
 * File Manager Service — REST API for Object Store operations.
 *
 * Uses @protocol:'rest' instead of OData because file operations
 * (multipart upload, streaming download, copy+delete rename/move)
 * require full HTTP req/res control that OData does not support cleanly.
 */
@protocol: 'rest'
@path: '/api/files'
@requires: 'authenticated-user'
service FileManagerService {

  // ── File listing ────────────────────────────────────────────────────────────
  @readonly
  @requires: 'FileViewer'
  function listFiles(prefix: String) returns array of {
    name         : String;
    objectKey    : String;
    objectPath   : String;
    itemType     : String;
    size         : Integer64;
    lastModified : DateTime;
    contentType  : String;
    isFolder     : Boolean;
  };

  // ── Folder tree (for move dialog) ───────────────────────────────────────────
  @readonly
  @requires: 'FileViewer'
  function getFolderTree() returns array of {
    name         : String;
    folderPrefix : String;
    parentPrefix : String;
    level        : Integer;
  };

  // ── Folder creation ─────────────────────────────────────────────────────────
  @requires: 'FileManager'
  action createFolder(prefix: String, folderName: String) returns {
    success      : Boolean;
    message      : String;
    folderPrefix : String;
  };

  // ── Rename (copy + delete) ──────────────────────────────────────────────────
  @requires: 'FileManager'
  action renameItem(sourceKey: String, newName: String, itemType: String) returns {
    success : Boolean;
    message : String;
    newKey  : String;
  };

  // ── Move (copy + delete) ────────────────────────────────────────────────────
  @requires: 'FileManager'
  action moveItem(sourceKey: String, targetPrefix: String, itemType: String) returns {
    success : Boolean;
    message : String;
    newKey  : String;
  };

  // ── Delete ──────────────────────────────────────────────────────────────────
  @requires: 'FileManager'
  action deleteItem(objectKey: String, itemType: String, recursive: Boolean) returns {
    success      : Boolean;
    message      : String;
    deletedCount : Integer;
  };
}
