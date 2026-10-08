import { getDb } from "@/db/client";

export type AppUser = {
  id: string;
  authProviderId: string;
  email: string;
  name: string | null;
};

const select = { id: true, authProviderId: true, email: true, name: true } as const;

export const usersRepository = {
  findByAuthProviderId(authProviderId: string): Promise<AppUser | null> {
    return getDb().user.findUnique({ where: { authProviderId }, select });
  },

  findById(id: string): Promise<AppUser | null> {
    return getDb().user.findUnique({ where: { id }, select });
  },

  findByEmail(email: string): Promise<AppUser | null> {
    return getDb().user.findUnique({ where: { email }, select });
  },

  create(data: { authProviderId: string; email: string; name: string | null }): Promise<AppUser> {
    return getDb().user.create({ data, select });
  },
};
