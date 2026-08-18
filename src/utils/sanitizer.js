"use strict";
// ============================================================
// sanitizer.ts — Làm sạch output từ Z.AI GLM model
// Tách từ server.ts (lines 249–280) để dễ test và tái sử dụng.
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeToken = sanitizeToken;
exports.autoCloseXmlTags = autoCloseXmlTags;
exports.isWAFError = isWAFError;
/**
 * Sửa các lỗi typo phổ biến trong XML tool tags mà GLM sinh ra.
 * Ví dụ: <write_to_file> → <write_to_file>, </replace_in_file> → </replace_in_file>
 * Early return nếu token không có '<' để tránh regex overhead (Issue #3 fix).
 */
/**
 * Sửa các lỗi typo phổ biến trong XML tool tags mà GLM sinh ra.
 * Ví dụ: <write_to_file> → <write_to_file>, <file_path>'Count.java'</file_path> → <file_path>Count.java</file_path>
 */
function sanitizeToken(token) {
    if (!token || !token.includes('<'))
        return token;
    let fixed = token
        .replace(/write_to_file/g, 'write_to_file')
        .replace(/write_to_file>/g, 'write_to_file>')
        .replace(/replce_in_file/g, 'replace_in_file')
        .replace(/read_fle/g, 'read_file')
        .replace(/list_fles/g, 'list_files')
        .replace(/search_fles/g, 'search_files')
        .replace(/search_contet/g, 'search_content')
        .replace(/run_comand/g, 'run_command');
    // Bảo vệ question schema: bắt mọi dạng token chứa q/option/question tags (kể cả bị cắt).
    // Zen question parser cực kỳ nhạy cảm với format attribute quotes và whitespace bên trong.
    // Fix question-render: dùng 1 regex case-insensitive thay vì 10 lệnh includes,
    // match cả newline, tab, self-closing, và closing tag bị cắt giữa chừng.
    // Regex: < , optional /, tên tag (q|option|question), rồi theo sau là whitespace/'>''/'/' hoặc end-of-string.
    const hasQuestionSchema = /<\/?(?:q|option|question)(?:[\s/>]|$)/i.test(token);
    if (hasQuestionSchema)
        return fixed;
    // Lọc bỏ dấu nháy đơn ('), nháy kép ("), hoặc khoảng trắng rác trong thẻ file_path hoặc path
    // (chỉ áp dụng khi không có question schema)
    fixed = fixed.replace(/<(file_path|path)>[\s'"]*([^<'"]+?)[\s'"]*<\/(file_path|path)>/gi, (match, openTag, filePath, closeTag) => {
        const cleanPath = filePath.trim().replace(/^['\"]+|['\"]+$/g, '');
        return `<${openTag}>${cleanPath}</${closeTag}>`;
    });
    // Sửa closing tags bị typo bên trong
    fixed = fixed.replace(/<\/(write_to_file|replace_in_file|read_file|list_files|search_files|search_content|run_command)>/g, (match, p1) => {
        const fixedTag = p1
            .replace(/write_toile/, 'write_to_file')
            .replace(/replce_in_file/, 'replace_in_file')
            .replace(/read_fle/, 'read_file')
            .replace(/list_fles/, 'list_files')
            .replace(/search_fles/, 'search_files')
            .replace(/search_contet/, 'search_content')
            .replace(/run_comand/, 'run_command');
        return `</${fixedTag}>`;
    });
    // Sửa closing tags bị mất dấu '>' — CHỈ áp dụng cho tool/UI tags đã biết, KHÔNG cho q/option
    const knownToolTags = ['write_to_file', 'replace_in_file', 'read_file', 'list_files', 'search_files', 'search_content', 'run_command', 'file_path', 'path', 'content', 'command', 'markdown', 'thinking'];
    const knownTagPattern = knownToolTags.join('|');
    fixed = fixed.replace(new RegExp(`<\\/(${knownTagPattern})([^>]*)$`, 'gm'), (match, tagName, rest) => {
        if (!rest.includes('>')) {
            return `</${tagName}>`;
        }
        return match;
    });
    return fixed;
}
function autoCloseXmlTags(fullText) {
    if (!fullText)
        return '';
    let result = fullText;
    const tags = [
        'file_path',
        'path',
        'content',
        'command',
        'read_file',
        'write_to_file',
        'replace_in_file',
        'list_files',
        'search_files',
        'search_content',
        'run_command',
        'thinking',
        'markdown'
    ];
    for (const tag of tags) {
        if (result.includes(`<${tag}>`) && !result.includes(`</${tag}>`)) {
            result += `\n</${tag}>`;
        }
    }
    return result;
}
/**
 * Kiểm tra lỗi có phải do WAF block không.
 */
function isWAFError(errMsg) {
    const lower = errMsg.toLowerCase();
    return (lower.includes('waf') ||
        lower.includes('blocked') ||
        lower.includes('captcha') ||
        lower.includes('403') ||
        lower.includes('405') ||
        lower.includes('429') ||
        lower.includes('rate limit'));
}
