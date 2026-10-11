import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { Markdown } from "../src/components/Markdown.tsx";
import { SettingsProvider, useSettings } from "../src/lib/settings.ts";
import { renderMermaid, validateMermaidSvg } from "../src/lib/mermaidRender.ts";

declare global { interface Window { mermaidQA: { text: (text: string) => void; theme: (theme: "dark" | "light") => void; show: (show: boolean) => void; validate: (svg: string) => boolean; diagnose: (source: string) => Promise<string>; size: (source: string) => Promise<number> } } }
function Fixture() {
  const [text, setText] = useState("Prose only.");
  const [show, setShow] = useState(true);
  const { update } = useSettings();
  window.mermaidQA = { text: setText, theme: (theme) => update({ theme }), show: setShow,
    size: async (source) => (await renderMermaid(source, "light")).width,
    diagnose: async (source) => { try { await renderMermaid(source, "dark"); return "OK"; } catch (error) { return String(error); } },
    validate: (svg) => { try { validateMermaidSvg(svg); return true; } catch { return false; } } };
  return <main className="chat-view"><button type="button" id="outside">Outside</button>{show && <Markdown>{text}</Markdown>}</main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
