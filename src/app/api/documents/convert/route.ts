import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';
import { bufferToMarkdown, canConvertToMarkdown } from '@/lib/markdownConversion';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, sanitizeFileName, ensureTextFileName } from '@/lib/storage-path';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { isNasConfigured, putObject, presignGet } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const parseBoolean = (value: FormDataEntryValue | null | undefined, fallback = false) => {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const formData = await req.formData();
        const file = formData.get('file');
        if (!(file instanceof File)) {
            return NextResponse.json({ error: 'Archivo requerido' }, { status: 400 });
        }

        if (file.size > MAX_FILE_SIZE) {
            return NextResponse.json({ error: 'El archivo supera 50MB' }, { status: 413 });
        }

        const workspaceIdInput = formData.get('workspaceId');
        const workspaceId = typeof workspaceIdInput === 'string' && workspaceIdInput.trim() ? workspaceIdInput : PERSONAL_WORKSPACE_ID;

        if (!isPersonalWorkspaceId(workspaceId)) {
            const member = await isWorkspaceMember(workspaceId, auth.uid);
            if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const folderInput = formData.get('folder');
        const folder = typeof folderInput === 'string' ? normalizeFolderPath(folderInput) : normalizeFolderPath();

        if (!canConvertToMarkdown(file.type, file.name)) {
            return NextResponse.json({ error: 'Tipo de archivo no soportado para conversión' }, { status: 415 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const conversion = await bufferToMarkdown(buffer, { mimeType: file.type, fileName: file.name });

        const shouldCreate = parseBoolean(formData.get('createDocument'), true);
        const persistOriginal = parseBoolean(formData.get('persistOriginal'), true);
        const ownerId = auth.uid;

        let sourceStoragePath: string | null = null;
        let sourceUrl: string | null = null;

        if (persistOriginal) {
            const safeName = sanitizeFileName(file.name);
            sourceStoragePath = buildStoragePath({
                workspaceId,
                ownerId,
                folder,
                fileName: safeName
            });
            await putObject(sourceStoragePath, buffer, {
                contentType: file.type || 'application/octet-stream',
                metadata: { 'agora-source': 'convert-original', 'agora-owner': ownerId }
            });
            sourceUrl = await presignGet(sourceStoragePath, 60 * 60);
        }

        let createdDoc: Record<string, unknown> | null = null;

        if (shouldCreate) {
            const mdName = ensureTextFileName(conversion.suggestedName);
            const mdStoragePath = buildStoragePath({
                workspaceId,
                ownerId,
                folder,
                fileName: mdName
            });
            const { contentHash, size } = await putObject(mdStoragePath, conversion.markdown, {
                contentType: 'text/markdown',
                metadata: { 'agora-source': 'convert-md', 'agora-owner': ownerId }
            });

            const docRef = await adminDb.collection('documents').add({
                name: conversion.suggestedName,
                type: DocumentType.Text,
                mimeType: 'text/markdown',
                ownerId,
                workspaceId,
                folder,
                storagePath: mdStoragePath,
                storageBackend: 'minio',
                contentHash,
                size,
                version: 1,
                baseVersion: 0,
                syncState: 'synced',
                lastWriter: ownerId,
                sourceName: file.name,
                sourceMimeType: file.type || null,
                sourceStoragePath,
                sourceUrl,
                sourceFormat: conversion.sourceFormat,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
            });

            await emitPing({
                scope: 'document',
                workspaceId,
                userId: ownerId,
                docId: docRef.id,
                path: mdStoragePath,
                version: 1,
                contentHash,
                sender: ownerId
            }).catch(() => undefined);

            createdDoc = {
                id: docRef.id,
                name: conversion.suggestedName,
                type: DocumentType.Text,
                mimeType: 'text/markdown',
                ownerId,
                workspaceId,
                folder,
                storagePath: mdStoragePath,
                storageBackend: 'minio',
                contentHash,
                size,
                version: 1,
                sourceName: file.name,
                sourceMimeType: file.type || null,
                sourceStoragePath,
                sourceUrl,
                updatedAt: { seconds: Date.now() / 1000 }
            };
        }

        return NextResponse.json({
            markdown: conversion.markdown,
            suggestedName: conversion.suggestedName,
            createdDoc
        });
    } catch (error: unknown) {
        console.error('Error al convertir a markdown:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error, 'Error inesperado') }, { status: 500 });
    }
}
