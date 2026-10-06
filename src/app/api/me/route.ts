import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";

export const GET = apiHandler(async () => {
  const user = await requireUser();
  return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } });
});
