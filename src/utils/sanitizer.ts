// ============================================================
// sanitizer.ts — Làm sạch output từ Z.AI GLM model
// Tách từ server.ts (lines 249–280) để dễ test và tái sử dụng.
// ============================================================

/**
 * Sửa các lỗi typo phổ biến trong XML tool tags mà GLM sinh ra.
 * Ví dụ: <write_toile> → <write_to_file>, </replce_in_file> → </replace_in_file>
 * Early return nếu token không có '<' để tránh regex overhead (Issue #3 fix).
 */
/**
 * Sửa các lỗi typo phổ biến trong XML tool tags mà GLM sinh ra.
 * Ví dụ: <write_toile> → <write_to_file>, <file_path>'Count.java'</file_path> → <file_path>Count.java</file_path>
 */
export function sanitizeToken(token: string): string {
    if (!token || !token.includes('<')) return token;

    let fixed = token
        .replace(/write_toile/g, 'write_to_file')
        .replace(/write_toile>/g, 'write_to_file>')
        .replace(/replce_in_file/g, 'replace_in_file')
        .replace(/read_fle/g, 'read_file')
        .replace(/list_fles/g, 'list_files')
        .replace(/search_fles/g, 'search_files')
        .replace(/search_contet/g, 'search_content')
        .replace(/run_comand/g, 'run_command');

    // 🚀 Lọc bỏ dấu nháy đơn ('), nháy kép ("), hoặc khoảng trắng rác trong thẻ file_path hoặc path
    fixed = fixed.replace(/<(file_path|path)>[\s'"]*([^<'"]+?)[\s'"]*<\/(file_path|path)>/gi, (match, openTag, filePath, closeTag) => {
        const cleanPath = filePath.trim().replace(/^['"]+|['"]+$/g, '');
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

    // Sửa closing tags bị mất dấu '>'
    fixed = fixed.replace(/<\/([a-z_]+)([^>]*)$/gm, (match, tagName, rest) => {
        if (!rest.includes('>')) {
            return `</${tagName}>`;
        }
        return match;
    });

    return fixed;
}

/**
 * Tự động kiểm tra và bổ sung các thẻ đóng XML nếu luồng stream bị kết thúc giữa chừng
 */
export function autoCloseXmlTags(fullText: string): string {
    if (!fullText) return '';
    let result = fullText;

    // Kiểm tra nếu thẻ <content> mở nhưng chưa đóng
    if (result.includes('<content>') && !result.includes('</content>')) {
        result += '\n</content>';
    }

    // Kiểm tra nếu thẻ <write_to_file> mở nhưng chưa đóng
    if (result.includes('<write_to_file>') && !result.includes('</write_to_file>')) {
        result += '\n</write_to_file>';
    }

    // Kiểm tra nếu thẻ <replace_in_file> mở nhưng chưa đóng
    if (result.includes('<replace_in_file>') && !result.includes('</replace_in_file>')) {
        result += '\n</replace_in_file>';
    }

    return result;
}

/**
 * Kiểm tra lỗi có phải do WAF block không.
 */
export function isWAFError(errMsg: string): boolean {
    const lower = errMsg.toLowerCase();
    return (
        lower.includes('waf') ||
        lower.includes('blocked') ||
        lower.includes('captcha') ||
        lower.includes('403') ||
        lower.includes('405') ||
        lower.includes('429') ||
        lower.includes('rate limit')
    );
}
