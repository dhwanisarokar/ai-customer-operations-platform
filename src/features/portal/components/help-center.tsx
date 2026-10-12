"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHelpArticle, useHelpSearch } from "../hooks";
import { usePortalInfo } from "../portal-context";
import { ErrorPanel, LoadingRows } from "./portal-states";

/** Browse and search the organization's PUBLISHED help articles. */
export function HelpCenter() {
  const { slug } = usePortalInfo();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const query = useHelpSearch(q, page);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Help center</h1>
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setQ(input);
        }}
      >
        <Input
          aria-label="Search articles"
          placeholder="Search for an answer…"
          value={input}
          maxLength={120}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button type="submit">Search</Button>
      </form>

      {query.isPending ? (
        <LoadingRows />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          title={q ? "No articles found" : "No articles yet"}
          description={
            q
              ? "Try different words, or start a conversation with our team."
              : "Articles will appear here once they are published."
          }
        />
      ) : (
        <>
          <ul className="border-border divide-border bg-card divide-y overflow-hidden rounded-xl border">
            {query.data.items.map((article) => (
              <li key={article.id}>
                <Link
                  href={`/portal/${slug}/help/${article.id}`}
                  className="hover:bg-muted/60 flex flex-col gap-1 px-4 py-3"
                >
                  <span className="text-sm font-medium">{article.title}</span>
                  <span className="text-muted-foreground text-sm">{article.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between text-sm">
            <p className="text-muted-foreground">{query.data.total} articles</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * query.data.pageSize >= query.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function HelpArticleView({ articleId }: { articleId: string }) {
  const { slug } = usePortalInfo();
  const query = useHelpArticle(articleId);
  return (
    <div className="flex flex-col gap-4">
      <Link href={`/portal/${slug}/help`} className="text-primary text-sm underline">
        &larr; Help center
      </Link>
      {query.isPending ? (
        <LoadingRows rows={2} />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <article className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{query.data.article.title}</h1>
          {/* Plain text: the article is never rendered as HTML. */}
          <div className="text-sm leading-relaxed whitespace-pre-wrap">
            {query.data.article.content}
          </div>
        </article>
      )}
    </div>
  );
}
