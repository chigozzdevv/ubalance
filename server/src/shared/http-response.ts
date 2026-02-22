export const ok = <T>(data: T, message?: string) => ({
  success: true,
  message,
  data
});

export const fail = (message: string) => ({
  success: false,
  message
});
