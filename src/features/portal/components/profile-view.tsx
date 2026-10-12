"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { usePortalProfile, useUpdateProfile } from "../hooks";
import type { PortalProfile } from "../types";
import { ErrorPanel, LoadingRows } from "./portal-states";

export function ProfileView() {
  const query = usePortalProfile();
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Your profile</h1>
      {query.isPending ? (
        <LoadingRows rows={2} />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <ProfileForm profile={query.data.profile} />
      )}
    </div>
  );
}

function ProfileForm({ profile }: { profile: PortalProfile }) {
  const update = useUpdateProfile();
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const error = update.error instanceof ApiError ? update.error : null;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({ firstName, lastName: lastName || null, phone: phone || null });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-first">First name</Label>
          <Input
            id="profile-first"
            value={firstName}
            maxLength={100}
            onChange={(e) => setFirstName(e.target.value)}
          />
          {error?.fieldErrors.firstName ? (
            <p className="text-destructive text-sm">{error.fieldErrors.firstName}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-last">Last name</Label>
          <Input
            id="profile-last"
            value={lastName}
            maxLength={100}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-phone">Phone</Label>
        <Input
          id="profile-phone"
          value={phone}
          maxLength={40}
          onChange={(e) => setPhone(e.target.value)}
        />
        {error?.fieldErrors.phone ? (
          <p className="text-destructive text-sm">{error.fieldErrors.phone}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-email">Email</Label>
        <Input id="profile-email" value={profile.email ?? ""} readOnly disabled />
        <p className="text-muted-foreground text-xs">
          Your email identifies your account and cannot be changed here. Contact support to change
          it.
        </p>
      </div>
      {profile.company ? (
        <p className="text-muted-foreground text-sm">Company: {profile.company}</p>
      ) : null}
      {update.isError && !error?.fieldErrors.firstName && !error?.fieldErrors.phone ? (
        <Alert variant="destructive">
          <AlertDescription>Could not save your profile. Try again.</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={update.isPending || !firstName.trim()}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {update.isSuccess ? <span className="text-muted-foreground text-sm">Saved.</span> : null}
      </div>
    </form>
  );
}
