-- CreateTable
CREATE TABLE "MailVerdict" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "promptVersion" TEXT NOT NULL DEFAULT '1',
    "inputVersion" TEXT NOT NULL DEFAULT '1',
    "model" TEXT,
    "analysisStatus" TEXT NOT NULL DEFAULT 'complete',
    "inputCoverage" TEXT,
    "purpose" TEXT,
    "subtype" TEXT,
    "summary" TEXT,
    "attentionMode" TEXT,
    "attentionUntil" DATETIME,
    "attentionPrecision" TEXT,
    "attentionBasis" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MailVerdict_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerdictAction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "verdictId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'unknown',
    "strength" TEXT NOT NULL DEFAULT 'requested',
    "dueAt" DATETIME,
    "duePrecision" TEXT,
    "expiresAt" DATETIME,
    "expiresPrecision" TEXT,
    "amount" REAL,
    "currency" TEXT,
    "reference" TEXT,
    "certainty" TEXT NOT NULL DEFAULT 'unknown',
    "evidence" TEXT,
    "evidenceSource" TEXT,
    CONSTRAINT "VerdictAction_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "MailVerdict" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerdictEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "verdictId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "startsAt" DATETIME,
    "startsPrecision" TEXT,
    "endsAt" DATETIME,
    "participation" TEXT NOT NULL DEFAULT 'unknown',
    "certainty" TEXT NOT NULL DEFAULT 'unknown',
    "evidence" TEXT,
    CONSTRAINT "VerdictEvent_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "MailVerdict" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerdictDocument" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "verdictId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "issuer" TEXT,
    "issueDate" DATETIME,
    "dueDate" DATETIME,
    "amount" REAL,
    "currency" TEXT,
    "reference" TEXT,
    "certainty" TEXT NOT NULL DEFAULT 'unknown',
    "evidence" TEXT,
    CONSTRAINT "VerdictDocument_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "MailVerdict" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EntityMention" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "verdictId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "nameRaw" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'mentioned',
    "identifier" TEXT,
    "certainty" TEXT NOT NULL DEFAULT 'unknown',
    "evidence" TEXT,
    CONSTRAINT "EntityMention_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "MailVerdict" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerdictContext" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "verdictId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "certainty" TEXT NOT NULL DEFAULT 'unknown',
    "evidence" TEXT,
    CONSTRAINT "VerdictContext_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "MailVerdict" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerdictUncertainty" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "verdictId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "fieldPath" TEXT,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "resolvableWith" TEXT,
    CONSTRAINT "VerdictUncertainty_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "MailVerdict" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "MailVerdict_messageId_key" ON "MailVerdict"("messageId");

-- CreateIndex
CREATE INDEX "MailVerdict_attentionMode_attentionUntil_idx" ON "MailVerdict"("attentionMode", "attentionUntil");

-- CreateIndex
CREATE INDEX "MailVerdict_schemaVersion_promptVersion_idx" ON "MailVerdict"("schemaVersion", "promptVersion");

-- CreateIndex
CREATE INDEX "MailVerdict_purpose_idx" ON "MailVerdict"("purpose");

-- CreateIndex
CREATE INDEX "VerdictAction_messageId_idx" ON "VerdictAction"("messageId");

-- CreateIndex
CREATE INDEX "VerdictAction_kind_actor_dueAt_idx" ON "VerdictAction"("kind", "actor", "dueAt");

-- CreateIndex
CREATE INDEX "VerdictAction_expiresAt_idx" ON "VerdictAction"("expiresAt");

-- CreateIndex
CREATE INDEX "VerdictEvent_messageId_idx" ON "VerdictEvent"("messageId");

-- CreateIndex
CREATE INDEX "VerdictEvent_kind_startsAt_idx" ON "VerdictEvent"("kind", "startsAt");

-- CreateIndex
CREATE INDEX "VerdictDocument_messageId_idx" ON "VerdictDocument"("messageId");

-- CreateIndex
CREATE INDEX "VerdictDocument_kind_issueDate_idx" ON "VerdictDocument"("kind", "issueDate");

-- CreateIndex
CREATE INDEX "VerdictDocument_issuer_idx" ON "VerdictDocument"("issuer");

-- CreateIndex
CREATE INDEX "EntityMention_messageId_idx" ON "EntityMention"("messageId");

-- CreateIndex
CREATE INDEX "EntityMention_kind_nameRaw_idx" ON "EntityMention"("kind", "nameRaw");

-- CreateIndex
CREATE INDEX "EntityMention_identifier_idx" ON "EntityMention"("identifier");

-- CreateIndex
CREATE INDEX "VerdictContext_messageId_idx" ON "VerdictContext"("messageId");

-- CreateIndex
CREATE INDEX "VerdictContext_kind_label_idx" ON "VerdictContext"("kind", "label");

-- CreateIndex
CREATE INDEX "VerdictUncertainty_messageId_idx" ON "VerdictUncertainty"("messageId");

-- CreateIndex
CREATE INDEX "VerdictUncertainty_reason_resolvableWith_idx" ON "VerdictUncertainty"("reason", "resolvableWith");

