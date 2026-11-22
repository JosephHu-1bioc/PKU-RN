/*
 * JWT payload 解码（只读，不验签，不发任何请求）。
 *
 * 为什么要它：列表页每行「观看」链接的 href 里带 token，payload 里有 hqySubId / hqyCourseId。
 * 这是唯一能离线把「表格行」和「播放器某一节」对起来的办法。
 *
 * 红线：token 是个人敏感凭据（内含账号、姓名、签名、nonce）。
 *     所以这里只向外暴露 subId / courseId / recordTime，token 明文不打印、不返回、不落盘。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});

  function base64UrlToBytes(input) {
    let b64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const bin = atob(b64); // 非法字符会抛异常，由调用方兜住
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** 只解 payload 段；失败返回 null，绝不抛到调用方。 */
  function decodePayload(token) {
    if (typeof token !== 'string' || !token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      const bytes = base64UrlToBytes(parts[1]);
      const json = new TextDecoder('utf-8').decode(bytes);
      const payload = JSON.parse(json);
      return payload && typeof payload === 'object' ? payload : null;
    } catch (err) {
      return null;
    }
  }

  /** 从 a[href] 里取 token 参数；相对地址按当前页解析。 */
  function readToken(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      const token = url.searchParams.get('token');
      return token || null;
    } catch (err) {
      return null;
    }
  }

  /** payload -> 业务主键。hqySubId 是唯一主键，缺失就判定这行不可用。 */
  function idsFromPayload(payload) {
    if (!payload) return null;
    const subId = payload.hqySubId != null ? String(payload.hqySubId).trim() : '';
    if (!subId) return null;
    return {
      subId,
      hqyCourseId: payload.hqyCourseId != null ? String(payload.hqyCourseId).trim() : null,
      recordTime: typeof payload.recordTime === 'string' ? payload.recordTime : null,
    };
  }

  PRN.token = { decodePayload, readToken, idsFromPayload };
})();
