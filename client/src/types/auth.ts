export type challenge_response = {
  wallet: string;
  message: string;
  expiresAtMs: number;
};

export type verify_response = {
  wallet: string;
  token: string;
  expiresAtMs: number;
};
