import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateOrganizationForm } from "@/features/organizations/components/create-organization-form";
import { OrganizationSwitcher } from "@/features/organizations/components/organization-switcher";
import { requireUser, resolveOrganizationContext } from "@/server/auth/context";
import { UnauthorizedError } from "@/server/errors";
import type { AppUser } from "@/server/repositories/users";
import { listMembers } from "@/server/services/memberships";
import { listOrganizationsForUser } from "@/server/services/organizations";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser().catch((error: unknown) => {
    if (error instanceof UnauthorizedError) redirect("/sign-in");
    throw error;
  });

  const organizations = await listOrganizationsForUser(user);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <Card>
        <CardHeader>
          <CardTitle>Current user</CardTitle>
          <CardDescription>Signed in as</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="font-medium">{user.name ?? user.email}</p>
          {user.name ? <p className="text-muted-foreground text-sm">{user.email}</p> : null}
        </CardContent>
      </Card>

      {organizations.length === 0 ? (
        <EmptyState />
      ) : (
        <OrganizationSection user={user} organizations={organizations} />
      )}
    </main>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your first organization</CardTitle>
        <CardDescription>
          Organizations hold your team, customers and AI agents. You will be its owner.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CreateOrganizationForm />
      </CardContent>
    </Card>
  );
}

async function OrganizationSection({
  user,
  organizations,
}: {
  user: AppUser;
  organizations: { id: string; name: string }[];
}) {
  const ctx = await resolveOrganizationContext(user);
  const members = await listMembers(ctx);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Current organization</CardTitle>
          <CardDescription>
            {ctx.organization.slug} &middot; your role: <strong>{ctx.membership.role}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <OrganizationSwitcher
            organizations={organizations.map(({ id, name }) => ({ id, name }))}
            activeId={ctx.organization.id}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? "member" : "members"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-border divide-y">
            {members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium">{member.name ?? member.email}</p>
                  {member.name ? (
                    <p className="text-muted-foreground text-xs">{member.email}</p>
                  ) : null}
                </div>
                <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium">
                  {member.role}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New organization</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateOrganizationForm />
        </CardContent>
      </Card>
    </>
  );
}
