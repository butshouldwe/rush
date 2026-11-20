import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  parseTree,
  SyntaxKind,
  type Edit,
} from 'jsonc-parser';
import { fail } from './json.js';

/** Delete owned syntax/value spans, never the surrounding comment trivia. */
export function removeValue(text: string, location: (string | number)[], file: string): string {
  const node = findNodeAtLocation(parseTree(text)!, location);
  if (!node) return fail('JSONC_EDIT_UNSAFE', 'Cannot locate the value to remove', file);
  const member = node.parent?.type === 'property' ? node.parent : node;
  const collection = member.parent;
  const siblings = collection?.children;
  if (!siblings || (collection?.type !== 'object' && collection?.type !== 'array'))
    return fail('JSONC_EDIT_UNSAFE', 'Cannot remove a document root', file);
  const index = siblings.indexOf(member);
  const scanner = createScanner(text, true);
  const token = (offset: number) => {
    scanner.setPosition(offset);
    const kind = scanner.scan();
    return {
      kind,
      offset: scanner.getTokenOffset(),
      length: scanner.getTokenLength(),
      content: '',
    };
  };
  const end = member.offset + member.length;
  const after = token(end);
  let comma: Edit | undefined;
  if (after.kind === SyntaxKind.CommaToken) comma = after;
  else if (index > 0) {
    const previous = siblings[index - 1]!;
    const before = token(previous.offset + previous.length);
    if (before.kind !== SyntaxKind.CommaToken)
      return fail('JSONC_EDIT_UNSAFE', 'Cannot identify the field separator', file);
    comma = before;
  }
  const comments = createScanner(text, false);
  comments.setPosition(member.offset);
  let protectedComment = false;
  for (
    let kind = comments.scan();
    kind !== SyntaxKind.EOF && comments.getTokenOffset() < node.offset;
    kind = comments.scan()
  )
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia)
      protectedComment = true;
  const lineStart = text.lastIndexOf('\n', member.offset - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;
  if (
    !protectedComment &&
    /^[\t ]*$/u.test(text.slice(lineStart, member.offset)) &&
    /^[\t \r,]*$/u.test(text.slice(end, lineEnd))
  ) {
    const finish = newline === -1 ? lineEnd : lineEnd + 1;
    const edits: Edit[] = [{ offset: lineStart, length: finish - lineStart, content: '' }];
    if (comma && (comma.offset < lineStart || comma.offset >= finish)) edits.push(comma);
    return applyEdits(text, edits);
  }
  const edits: Edit[] = [{ offset: node.offset, length: node.length, content: '' }];
  if (member.type === 'property') {
    const key = member.children![0]!;
    const colon = token(key.offset + key.length);
    if (colon.kind !== SyntaxKind.ColonToken)
      return fail('JSONC_EDIT_UNSAFE', 'Cannot identify the property colon', file);
    edits.push({ offset: key.offset, length: key.length, content: '' }, colon);
  }
  if (comma) edits.push(comma);
  return applyEdits(text, edits);
}
