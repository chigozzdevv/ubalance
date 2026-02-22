import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    auth_wallet?: string;
  }
}
