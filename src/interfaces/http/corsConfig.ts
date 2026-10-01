import corsLib from 'cors';

/** Exact-match allowlist. An empty list means no cross-origin browser access at all. */
export function cors(allowedOrigins: string[]) {
  return corsLib({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowedOrigins.includes(origin));
    },
  });
}
