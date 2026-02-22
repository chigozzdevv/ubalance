export type challenge_record = {
  wallet: string;
  message: string;
  expires_at_ms: number;
};

export type session_record = {
  wallet: string;
  token: string;
  expires_at_ms: number;
};
