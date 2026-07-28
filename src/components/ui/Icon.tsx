import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowExpand01Icon,
  ArrowRight02Icon,
  BellIcon,
  Book02Icon,
  BookEditIcon,
  BookOpen01Icon,
  Calendar04Icon,
  Cancel01Icon,
  ChartColumnBigIcon,
  ChatEdit01Icon,
  CheckIcon,
  CheckListIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  Clock01Icon,
  CollapseIcon,
  Crown03Icon,
  DashboardSquare01Icon,
  Delete02Icon,
  Edit02Icon,
  EyeIcon,
  FileEmpty02Icon,
  FileExclamationPointIcon,
  FilterIcon,
  FlowSquareIcon,
  Globe02Icon,
  HelpCircleIcon,
  HelpSquareIcon,
  LeftToRightListBulletIcon,
  Link04Icon,
  Location01Icon,
  LogoutSquare01Icon,
  Menu01Icon,
  Message01Icon,
  Mic01Icon,
  MinimizeIcon,
  MoreVerticalIcon,
  PlusSignIcon,
  Search01Icon,
  SearchAddIcon,
  SearchMinusIcon,
  Settings01Icon,
  SparklesIcon,
  SquareLock02Icon,
  Upload01Icon,
  User02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, IconSvgElement } from "@hugeicons/react";
import type { CSSProperties } from "react";

const HugeIcons = {
  arrowRight: ArrowRight02Icon,
  bell: BellIcon,
  book: BookOpen01Icon,
  bookEdit: BookEditIcon,
  chart: ChartColumnBigIcon,
  check: CheckIcon,
  chevronDown: ChevronDownIcon,
  chevronUp: ChevronUpIcon,
  chevronLeft: ChevronLeftIcon,
  chevronRight: ChevronRightIcon,
  clock: Clock01Icon,
  collapse: CollapseIcon,
  dashboard: DashboardSquare01Icon,
  alert: Alert02Icon,
  view: ViewIcon,
  error: Alert02Icon,
  fileError: FileExclamationPointIcon,
  files: FileEmpty02Icon,
  filter: FilterIcon,
  flashcards: [
    "M5 7h11a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2z",
    "M8 4h11a2 2 0 012 2v8",
  ],
  globe: Globe02Icon,
  diagram: FlowSquareIcon,
  suggestionEdit: ChatEdit01Icon,
  help: HelpCircleIcon,
  link: Link04Icon,
  list: LeftToRightListBulletIcon,
  location: Location01Icon,
  lock: SquareLock02Icon,
  logout: LogoutSquare01Icon,
  maximize: ArrowExpand01Icon,
  menu: Menu01Icon,
  message: Message01Icon,
  microphone: Mic01Icon,
  minimize: MinimizeIcon,
  moreVertical: MoreVerticalIcon,
  palette: [
    "M12 3.5a8.5 8.5 0 00-.5 17c1 0 1.5-.8 1.5-1.6 0-1.2-1-1.6-1-2.6 0-.8.7-1.3 1.5-1.3H15a5 5 0 005-5C20 6.5 16.4 3.5 12 3.5z",
    "M7.5 12.5h.01",
    "M9.5 8.5h.01",
    "M14 8h.01",
  ],
  plus: PlusSignIcon,
  profile: User02Icon,
  quiz: HelpSquareIcon,
  schedule: Calendar04Icon,
  search: Search01Icon,
  send: ChevronRightIcon,
  settings: Settings01Icon,
  premium: Crown03Icon,
  sparkles: SparklesIcon,
  todo: CheckListIcon,
  trash: Delete02Icon,
  upload: Upload01Icon,
  warning: AlertCircleIcon,
  workspaces: Book02Icon,
  write: Edit02Icon,
  x: Cancel01Icon,
  zoomIn: SearchAddIcon,
  zoomOut: SearchMinusIcon,
} as const;

export type IconName = keyof typeof HugeIcons;

export type IconProps = React.ComponentProps<"svg"> & {
  className?: string;
  name: IconName;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
};

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  className,
  style,
  ...rest
}: IconProps) {
  const el = HugeIcons[name] ?? HugeIcons["x"];
  if (Array.isArray(el) && el.every((d) => typeof d === "string")) {
    return (
      <svg
        aria-hidden
        className={className}
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        style={{ display: "block", flex: "0 0 auto", ...style }}
        viewBox="0 0 24 24"
        width={size}
        {...rest}
      >
        {el.map((d, i) => (
          <path d={d} key={i} />
        ))}
      </svg>
    );
  } else {
    return (
      <HugeiconsIcon
        aria-hidden
        className={className}
        fill="none"
        height={size}
        color="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        style={{ display: "block", flex: "0 0 auto", ...style }}
        viewBox="0 0 24 24"
        width={size}
        icon={el as IconSvgElement}
        {...rest}
      />
    );
  }
}
