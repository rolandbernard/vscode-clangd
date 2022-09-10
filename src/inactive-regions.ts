
import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as config from './config';

import { ClangdContext } from './clangd-context';

export function activate(context: ClangdContext) {
  const feature = new InactiveRegionsFeature();
  context.client.registerFeature(feature);
  context.subscriptions.unshift(vscode.window.onDidChangeVisibleTextEditors(editors => {
    for (const editor of editors) {
      applyInactiveRegions(editor);
    }
  }));
}

let inactiveCodeTokenTypeIndex: number;
let inactiveCodeTokenTypeReplaceIndex: number;

class InactiveRegionsFeature implements vscodelc.StaticFeature {

  fillClientCapabilities(_capabilities: vscodelc.ClientCapabilities) { }

  initialize(
    capabilities: vscodelc.ServerCapabilities,
    _documentSelector: vscodelc.DocumentSelector | undefined
  ) {
    // Search for the index of the inactive ranges token type
    if (capabilities.semanticTokensProvider) {
      const tokenTypes = capabilities.semanticTokensProvider.legend.tokenTypes;
      for (let i = 0; i < tokenTypes.length; i++) {
        if (tokenTypes[i] === 'comment') {
          inactiveCodeTokenTypeIndex = i;
        }
      }
      inactiveCodeTokenTypeReplaceIndex = tokenTypes.length;
    }
  }

  getState(): vscodelc.FeatureState { return {kind: 'static'}; }

  dispose() { }
}

const lastTokens: WeakMap<vscode.TextDocument, vscode.SemanticTokens> = new WeakMap();
const lastInactiveRanges: WeakMap<vscode.TextDocument, vscode.Range[]> = new WeakMap();

function applyInactiveRegions(editor: vscode.TextEditor) {
  const inactiveRanges = lastInactiveRanges.get(editor.document);
  if (inactiveRanges) {
    editor.setDecorations(inactiveCodeDecorationType, inactiveRanges);
  }
}

function applyInactiveRegionsToDocument(document: vscode.TextDocument) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === document) {
      applyInactiveRegions(editor);
    }
  }
}

function replaceInactiveRanges(tokens: vscode.SemanticTokens): vscode.SemanticTokens {
  const data = new Uint32Array(tokens.data.length);
  data.set(tokens.data);
  const tokenCount = data.length / 5;
  for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex++) {
    const offset = 5 * tokenIndex;
    if (data[offset + 3] == inactiveCodeTokenTypeIndex) {
      data[offset + 3] = inactiveCodeTokenTypeReplaceIndex;
    }
  }
  return { resultId: tokens.resultId, data: data };
}

function computeInactiveRanges(tokens: vscode.SemanticTokens): vscode.Range[] {
  // For each token we have 5 different integers
  const data: Uint32Array = tokens.data;
  const tokenCount = data.length / 5;
  let lastLineNumber = 0;
  let lastStartCharacter = 0;
  const inactiveRanges: vscode.Range[] = [];
  for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex++) {
    const offset = 5 * tokenIndex;
    const deltaLine = data[offset];
    const deltaCharacter = data[offset + 1];
    const lineNumber = lastLineNumber + deltaLine;
    const startCharacter = (
      deltaLine === 0
        ? lastStartCharacter + deltaCharacter
        : deltaCharacter
    );
    const length = data[offset + 2];
    const tokenTypeIndex = data[offset + 3];
    if (tokenTypeIndex == inactiveCodeTokenTypeIndex) {
      inactiveRanges.push(new vscode.Range(
        new vscode.Position(lineNumber, startCharacter),
        new vscode.Position(lineNumber, startCharacter + length)
      ));
    }
    lastLineNumber = lineNumber;
    lastStartCharacter = startCharacter;
  }
  return inactiveRanges;
}

const inactiveCodeDecorationType =
  vscode.window.createTextEditorDecorationType({
    opacity: config.get<number>('inactiveRegionOpacity').toString(),
    rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
  });

export function provideDocumentSemanticTokens(
  document: vscode.TextDocument, tokens: vscode.SemanticTokens
) {
  lastTokens.set(document, tokens);
  lastInactiveRanges.set(document, computeInactiveRanges(tokens));
  applyInactiveRegionsToDocument(document);
  return replaceInactiveRanges(tokens);
}

function copy(dest: Uint32Array, destOffset: number, src: Uint32Array, srcOffset: number, length: number) {
  dest.set(src.subarray(srcOffset, srcOffset + length), destOffset);
}

function applyDelta(
  prev: vscode.SemanticTokens, delta: vscode.SemanticTokensEdits
): vscode.SemanticTokens {
  let deltaLength = 0;
  for (const edit of delta.edits) {
    deltaLength += (edit.data ? edit.data.length : 0) - edit.deleteCount;
  }
  const srcData = prev.data;
  const destData = new Uint32Array(srcData.length + deltaLength);
  let readIndex = 0;
  let insertIndex = 0;
  for (const edit of delta.edits) {
    const copyCount = edit.start - readIndex;
    if (copyCount > 0) {
      copy(destData, insertIndex, srcData, readIndex, copyCount);
      insertIndex += copyCount;
    }
    if (edit.data) {
      copy(destData, insertIndex, edit.data, 0, edit.data.length);
      insertIndex += edit.data.length;
    }
    readIndex = edit.start + edit.deleteCount;
  }
  if (readIndex < srcData.length) {
    copy(destData, insertIndex, srcData, readIndex, srcData.length - readIndex);
  }
  return { resultId: delta.resultId, data: destData };
}

function isSemanticTokens(
  tokens: vscode.SemanticTokens | vscode.SemanticTokensEdits
): tokens is vscode.SemanticTokens {
  return tokens && (tokens as vscode.SemanticTokens).data !== undefined;
}

export function provideDocumentSemanticTokensEdits(
  document: vscode.TextDocument, previousResultId: string,
  tokens: vscode.SemanticTokens | vscode.SemanticTokensEdits
) {
  if (!isSemanticTokens(tokens)) {
    const previousTokens = lastTokens.get(document);
    if (!previousTokens || previousTokens.resultId !== previousResultId) {
      return tokens;
    }
    tokens = applyDelta(previousTokens, tokens);
  }
  return provideDocumentSemanticTokens(document, tokens);
}

