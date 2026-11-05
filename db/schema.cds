namespace aidocparser;

entity ParsedDocument {
  key docId             : UUID;
      userId            : String(255);    // XSUAA subject
      originalName      : String(500);
      mimeType          : String(100);
      pageCount         : Integer default 0;
      hasOcr            : Boolean default false;
      tokensUsed        : Integer default 0;
      originalS3Key     : String(1000);   // originals/{userId}/{docId}/...
      parsedDestination : String(3);      // "sdm" | "s3"
      parsedRef         : String(1000);   // S3 key ou SDM objectId
      parsedFolderId    : String(255);    // SDM folderId (quando parsedDestination=sdm)
      createdAt         : Timestamp;
}
