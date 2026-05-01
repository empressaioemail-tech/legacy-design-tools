export { DashboardLayout } from "./components/DashboardLayout";
export type { DashboardLayoutProps } from "./components/DashboardLayout";
export { Sidebar } from "./components/Sidebar";
export type {
  SidebarProps,
  SidebarGroup,
  SidebarItem,
} from "./components/Sidebar";
export { Header } from "./components/Header";
export type { HeaderProps, HeaderSearch } from "./components/Header";
export { SubmitToJurisdictionDialog } from "./components/SubmitToJurisdictionDialog";
export type { SubmitToJurisdictionDialogProps } from "./components/SubmitToJurisdictionDialog";
export { SubmissionRecordedBanner } from "./components/SubmissionRecordedBanner";
export type { SubmissionRecordedBannerProps } from "./components/SubmissionRecordedBanner";
export { ReviewerComment } from "./components/ReviewerComment";
export type { ReviewerCommentProps } from "./components/ReviewerComment";

export {
  initTheme,
  setTheme,
  getTheme,
  toggleTheme,
  type ThemeName,
} from "./lib/theme";

export {
  useSidebarState,
  type SidebarStateValue,
} from "./lib/sidebar-state";
