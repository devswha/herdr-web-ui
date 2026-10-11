/**
 * A markdown file in a tab of its own: the document is the page, with its name, path, raw file
 * and download above it. Not the app: no sidebar, no panes, no connection to a PC's session.
 * Its links to other files open here, from the document's folder, and Back returns.
 */
import { useCallback, useEffect, useState } from "react";

import { FileViewer } from "./FileViewer.tsx";
import { OpenFileContext } from "../lib/filePaths.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { readerFromSearch, readerHref, resolveFromDocument, type ReaderTarget } from "../lib/fileReader.ts";

const close = (): void => {};

export function FileReader({ target }: { target: ReaderTarget }) {
  const [path, setPath] = useState(target.path);

  useEffect(() => {
    const onPop = (): void => {
      const next = readerFromSearch(window.location.search);
      if (next !== null) setPath(next.path);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = `${path.split("/").pop() || path} · herdr web ui`;
  }, [path]);

  const open = useCallback((linked: string) => {
    const next = resolveFromDocument(path, linked);
    window.history.pushState(null, "", readerHref(target.machine, next));
    setPath(next);
  }, [path, target.machine]);

  return <MachineContext.Provider value={target.machine}>
    <OpenFileContext.Provider value={open}>
      <FileViewer key={path} page path={path} paneId={null} onClose={close} onOpen={open} />
    </OpenFileContext.Provider>
  </MachineContext.Provider>;
}
