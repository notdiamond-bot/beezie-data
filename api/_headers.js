// Cloudflare 403s requests that arrive without a browser User-Agent. Browsers
// can't set this header, but a server-side caller must.
export const BEEZIE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
};
