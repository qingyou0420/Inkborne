/** First/new book introduction; author identity stays in the existing project profile.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import { fetchJson, useApi } from "../hooks/use-api";
import { AUTHOR_AVATAR_MAX_BYTES, AUTHOR_AVATAR_TYPES, AUTHOR_NAME_MAX, type AuthorPublic } from "../lib/author-profile";
import { usePreferencesStore } from "../store/preferences";
import { useChatStore } from "../store/chat";
import { startFreshBookCreateSession } from "../pages/chat-page-state";
import { registerNavigationGuard } from "../lib/edit-navigation";

export function NewBookIntro({ isZh, onEnterAsk }: {
  readonly isZh: boolean;
  readonly onEnterAsk: (sessionId: string) => void;
}) {
  const { data: author, loading, error: loadError, refetch, mutate } = useApi<AuthorPublic>("/author");
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<"name" | "avatar">("name");
  const [saved, setSaved] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const failedAvatar = useRef<File | null>(null);
  const entering = useRef(false);
  const nameSave = useRef<Promise<boolean> | null>(null);
  const liveName = useRef(name);
  const liveAuthor = useRef(author);
  liveName.current = name;
  liveAuthor.current = author;
  const showImage = usePreferencesStore((state) => state.showStudioImage);
  const createDraftSession = useChatStore((state) => state.createDraftSession);
  const setInput = useChatStore((state) => state.setInput);
  const currentName = name ?? author?.name ?? "";
  const avatar = author?.hasAvatar ? `/api/v1/author/avatar?v=${encodeURIComponent(author.updatedAt ?? "")}` : "";

  const saveName = (): Promise<boolean> => {
    if (nameSave.current) return nameSave.current;
    const pendingName = liveName.current;
    if (pendingName === null || pendingName === (liveAuthor.current?.name ?? "")) return Promise.resolve(true);
    setSaving(true);
    setError(null);
    setErrorAction("name");
    setSaved(false);
    failedAvatar.current = null;
    const task = (async () => {
      try {
        // A partial patch preserves the author's biography and avatar.
        const next = await fetchJson<AuthorPublic>("/author", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: pendingName }) });
        liveName.current = null;
        liveAuthor.current = next;
        mutate(next);
        setName(null);
        setSaved(true);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : (isZh ? "名字未保存，请重试。" : "Could not save the name. Please retry."));
        return false;
      } finally {
        nameSave.current = null;
        setSaving(false);
      }
    })();
    nameSave.current = task;
    return task;
  };
  useEffect(() => {
    if (name === null || name === (author?.name ?? "")) return;
    return registerNavigationGuard(saveName);
  }, [name, author?.name]);
  const uploadAvatar = async (file: File) => {
    failedAvatar.current = null;
    setErrorAction("avatar");
    if (!AUTHOR_AVATAR_TYPES.has(file.type) || file.size > AUTHOR_AVATAR_MAX_BYTES) {
      setError(isZh ? "请选择不超过 2 MB 的 PNG、JPG 或 WebP 图片。" : "Choose a PNG, JPG or WebP image under 2 MB.");
      return;
    }
    if (!await saveName()) return;
    setErrorAction("avatar");
    setSaving(true);
    setError(null);
    setSaved(false);
    failedAvatar.current = file;
    try {
      const body = new FormData();
      body.append("file", file);
      mutate(await fetchJson<AuthorPublic>("/author/avatar", { method: "POST", body }));
      failedAvatar.current = null;
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : (isZh ? "头像未保存，请重新选择。" : "Could not save the avatar. Please select it again."));
    } finally { setSaving(false); }
  };
  const enter = async () => {
    if (entering.current) return;
    entering.current = true;
    try {
      if (!await saveName()) return;
      const sessionId = startFreshBookCreateSession(createDraftSession);
      setInput("");
      onEnterAsk(sessionId);
    } finally { entering.current = false; }
  };

  return <section className="ink-intro" data-testid="new-book-intro">
    <div className="ink-intro-content">
      <div className="ink-intro-author">
        <button type="button" className="ink-avatar-upload" onClick={() => fileRef.current?.click()} disabled={saving || loading || !author}
          aria-label={isZh ? (avatar ? "更换头像" : "上传设置头像") : "Set author avatar"} title={isZh ? "上传 / 更换头像" : "Upload / change avatar"}>
          {avatar ? <img src={avatar} alt="" /> : <UserRound size={28} strokeWidth={1.2} />}
        </button>
        <input ref={fileRef} className="sr-only" tabIndex={-1} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadAvatar(file);
          event.target.value = "";
        }} />
        <input className="ink-author-name" value={currentName} maxLength={AUTHOR_NAME_MAX} disabled={saving || loading || !author}
          aria-label={isZh ? "署上你的名字" : "Your pen name"} placeholder={isZh ? "署上你的名字" : "Your pen name"}
          onChange={(event) => { liveName.current = event.target.value; setName(event.target.value); setSaved(false); }} onBlur={() => void saveName()}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void saveName(); event.currentTarget.blur(); } }} />
        <div className="ink-identity-status" aria-live="polite">
          {saving ? (isZh ? "正在保存…" : "Saving…") : saved ? (isZh ? "已保存" : "Saved") : null}
          {error ? <span className="text-destructive">{error} <button type="button" onClick={() => {
            if (errorAction === "name") void saveName();
            else if (failedAvatar.current) void uploadAvatar(failedAvatar.current);
            else fileRef.current?.click();
          }}>{errorAction === "avatar" && !failedAvatar.current ? (isZh ? "重新选择" : "Choose again") : (isZh ? "重试保存" : "Retry save")}</button></span> : null}
          {loadError && !author ? <span className="text-destructive">{isZh ? "作者资料未能读取。" : "Could not load the author profile."} <button type="button" onClick={() => void refetch()}>{isZh ? "重新读取" : "Retry"}</button></span> : null}
        </div>
      </div>
      <p className="ink-intro-stages ink-calligraphy">{isZh ? "问心 · 研墨 · 织卷 · 落笔" : "Ask · Ground · Weave · Write"}</p>
      <h1>{isZh ? "以墨问心，你想写一个什么样的故事？" : "What kind of story would you like to write?"}</h1>
      <p className="ink-intro-hint">{isZh ? "讨论故事框架，整理正典，才能进入设定、大纲与正文创作" : "Discuss the story and prepare its canon before settings, outlines and prose."}</p>
      <button type="button" className="btn-primary ink-intro-enter" disabled={saving && !nameSave.current} onClick={() => void enter()} data-testid="intro-enter-ask">{isZh ? "进入问心" : "Enter Ask"}</button>
    </div>
    {showImage && !imageFailed ? <img className="ink-intro-art" src="/assets/ink-study-v1.png" alt="" aria-hidden="true" onError={() => setImageFailed(true)} /> : null}
  </section>;
}
