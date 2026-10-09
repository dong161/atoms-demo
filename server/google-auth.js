// Google 登录：前端用 Google Identity Services 拿到 ID Token（JWT），服务端向 Google 校验真伪。
// 用 Google 官方 tokeninfo 接口校验签名与有效期，再核对 aud（本站客户端 ID）、iss、邮箱已验证。

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export async function verifyGoogleIdToken(idToken, clientId, { fetchImpl = fetch } = {}) {
  if (!clientId) throw Object.assign(new Error('未配置 Google 登录'), { status: 501 });
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096)
    throw Object.assign(new Error('Google 凭证格式不正确'), { status: 400 });
  const res = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw Object.assign(new Error('Google 凭证无效或已过期'), { status: 401 });
  const info = await res.json();
  if (info.aud !== clientId) throw Object.assign(new Error('Google 凭证不是发给本站的'), { status: 401 });
  if (!ISSUERS.has(info.iss)) throw Object.assign(new Error('Google 凭证签发方不正确'), { status: 401 });
  if (Number(info.exp) * 1000 < Date.now()) throw Object.assign(new Error('Google 凭证已过期'), { status: 401 });
  if (String(info.email_verified) !== 'true') throw Object.assign(new Error('Google 邮箱未验证'), { status: 401 });
  return {
    sub: String(info.sub),
    email: String(info.email || '').toLowerCase(),
    name: String(info.name || info.email || 'Google 用户').slice(0, 30),
  };
}
