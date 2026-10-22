import { Cloud, FolderOpen } from "lucide-react";
import DriveFilesDrawer from "./DriveFilesDrawer.jsx";

/**
 * Gradcon Cloud Storage (Grady, 22 Oct 2026: "i need the google drive access
 * amongst the dashboard … use that space and name it Gradcon Cloud Storage
 * and let the gradcon vault and its parameters be under this"): the office's
 * Google Drive project files, browsed in place from the office folder down
 * (read-only — api/drive.js), with the Gradcon Vault and everything it held
 * (one folder per project, the Office folder, communications) underneath,
 * unchanged. The portal's "Google Drive" button lands here.
 */
export default function CloudStorageView({ children }) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 print:hidden" data-testid="cloud-storage">
      <div>
        <h1 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
          <Cloud size={20} className="text-orange-500" /> Gradcon Cloud Storage
        </h1>
        <p className="text-xs text-neutral-500 mt-0.5">The office's project files in Google Drive (projects@), read inside the app — browse, search, preview, open in Drive. Each project's own Files button attaches from the same folder. Dropbox follows as a second source.</p>
      </div>
      <DriveFilesDrawer inline mode="browse" quote={null} />
      <div className="border-t border-neutral-200 pt-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-neutral-500 flex items-center gap-1"><FolderOpen size={12} /> Gradcon Vault — documents and communications held in the app</div>
      </div>
      {children}
    </div>
  );
}
