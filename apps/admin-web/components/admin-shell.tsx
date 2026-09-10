'use client';

import {
  Badge,
  Breadcrumb,
  BreadcrumbDivider,
  BreadcrumbItem,
  Button,
  FluentProvider,
  Link,
  SearchBox,
  Text,
  Title2,
  makeStyles,
  mergeClasses,
  tokens,
  webLightTheme,
} from '@fluentui/react-components';
import {
  AppsListDetail24Regular,
  ArrowRouting24Regular,
  BuildingBank24Regular,
  BuildingShop24Regular,
  ClipboardTaskListLtr24Regular,
  ContentView24Regular,
  DocumentBulletList24Regular,
  Home24Regular,
  KeyCommand24Regular,
  Navigation24Regular,
  PeopleTeam24Regular,
  PersonAccounts24Regular,
  ShieldTask24Regular,
} from '@fluentui/react-icons';
import type { ComponentType, ReactNode } from 'react';
import { Fragment, useState } from 'react';

import { type AdminSubject, dataScopeLabels, hasPermission } from '../lib/permissions';

type NavigationItem = Readonly<{
  label: string;
  href: string;
  permission: string;
  icon: ComponentType<{ 'aria-hidden'?: boolean }>;
}>;

const navigationItems: readonly NavigationItem[] = [
  { label: '总览', href: '/overview', permission: 'overview:read', icon: Home24Regular },
  { label: '用户', href: '/users', permission: 'users:read', icon: PersonAccounts24Regular },
  {
    label: '供应商',
    href: '/providers',
    permission: 'providers:read',
    icon: BuildingShop24Regular,
  },
  { label: '模型能力', href: '/models', permission: 'models:read', icon: AppsListDetail24Regular },
  { label: '定价', href: '/pricing', permission: 'pricing:read', icon: BuildingBank24Regular },
  { label: '路由', href: '/routing', permission: 'routing:read', icon: ArrowRouting24Regular },
  { label: '任务', href: '/tasks', permission: 'tasks:read', icon: ClipboardTaskListLtr24Regular },
  {
    label: '财务',
    href: '/finance/orders',
    permission: 'finance:read',
    icon: BuildingBank24Regular,
  },
  { label: '内容运营', href: '/content', permission: 'content:read', icon: ContentView24Regular },
  {
    label: '工单',
    href: '/tickets',
    permission: 'tickets:read',
    icon: DocumentBulletList24Regular,
  },
  { label: '后台权限', href: '/iam', permission: 'iam:read', icon: PeopleTeam24Regular },
  { label: '审计', href: '/audit', permission: 'audit:read', icon: ShieldTask24Regular },
  { label: '系统运行', href: '/system', permission: 'system:read', icon: KeyCommand24Regular },
];

export type AdminAction = Readonly<{
  label: string;
  permission: string;
  onClick?: () => void;
}>;

export type BreadcrumbDescriptor = Readonly<{
  label: string;
  href: string;
}>;

export type AdminShellProps = Readonly<{
  subject: AdminSubject;
  children: ReactNode;
  breadcrumbs?: readonly BreadcrumbDescriptor[];
  environment?: string;
  identity?: string;
  actions?: readonly AdminAction[];
}>;

const useStyles = makeStyles({
  root: {
    minHeight: '100vh',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'grid',
    gridTemplateColumns: '244px minmax(0, 1fr)',
    gridTemplateRows: '64px minmax(0, 1fr)',
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
      gridTemplateRows: '64px 64px auto auto minmax(0, 1fr)',
    },
  },
  brand: {
    gridColumn: '1',
    gridRow: '1',
    backgroundColor: '#0b1f33',
    color: '#ffffff',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    paddingLeft: '20px',
    borderBottom: '1px solid #28445f',
  },
  brandTitle: {
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.02em',
  },
  brandDomain: {
    color: '#b7c9da',
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
  },
  header: {
    gridColumn: '2',
    gridRow: '1',
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '0 20px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    '@media (max-width: 900px)': {
      gridColumn: '1',
      gridRow: '2',
      paddingLeft: '12px',
    },
  },
  desktopHeaderContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    '@media (max-width: 900px)': {
      minWidth: 0,
    },
  },
  search: {
    width: '100%',
  },
  searchContainer: {
    position: 'relative',
    width: 'min(420px, 42vw)',
    '@media (max-width: 680px)': {
      width: '176px',
    },
  },
  searchResults: {
    position: 'absolute',
    zIndex: 10,
    top: '38px',
    left: 0,
    right: 0,
    maxHeight: '280px',
    overflowY: 'auto',
    padding: '6px',
    margin: 0,
    listStyleType: 'none',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
  },
  searchResultItem: {
    display: 'flex',
  },
  searchResultLink: {
    width: '100%',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusSmall,
    textDecorationLine: 'none',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      textDecorationLine: 'none',
    },
    ':focus-visible': {
      outlineColor: tokens.colorBrandStroke1,
      outlineStyle: 'solid',
      outlineWidth: '2px',
    },
  },
  emptySearchResult: {
    padding: '8px 10px',
    color: tokens.colorNeutralForeground3,
  },
  headerMeta: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    '@media (max-width: 900px)': {
      display: 'none',
    },
  },
  mobileMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    gridColumn: '1',
    gridRow: '3',
    padding: '10px 12px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    '@media (min-width: 901px)': {
      display: 'none',
    },
  },
  menuButton: {
    display: 'none',
    '@media (max-width: 900px)': {
      display: 'inline-flex',
    },
  },
  sidebar: {
    gridColumn: '1',
    gridRow: '2',
    backgroundColor: '#0b1f33',
    padding: '12px 10px',
    '@media (max-width: 900px)': {
      gridRow: '4',
      display: 'none',
      maxHeight: '52vh',
      overflowY: 'auto',
    },
  },
  sidebarOpen: {
    '@media (max-width: 900px)': {
      display: 'block',
    },
  },
  navigation: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  navigationLink: {
    color: '#e8f0f7',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minHeight: '38px',
    padding: '0 10px',
    borderRadius: tokens.borderRadiusMedium,
    textDecorationLine: 'none',
    ':hover': {
      color: '#ffffff',
      backgroundColor: '#173b5d',
      textDecorationLine: 'none',
    },
    ':focus-visible': {
      outlineColor: '#8dc8ff',
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineOffset: '-2px',
    },
  },
  main: {
    gridColumn: '2',
    gridRow: '2',
    minWidth: 0,
    padding: '18px 22px 28px',
    '@media (max-width: 900px)': {
      gridColumn: '1',
      gridRow: '5',
      padding: '14px 12px 24px',
    },
  },
  contextBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    minHeight: '36px',
    marginBottom: '12px',
  },
  currentBreadcrumb: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '32px',
    padding: '0 8px',
    fontWeight: tokens.fontWeightSemibold,
  },
  actions: {
    display: 'flex',
    gap: '8px',
  },
});

export function AdminShell({
  actions = [],
  breadcrumbs = [{ label: '总览', href: '/overview' }],
  children,
  environment = '生产',
  identity,
  subject,
}: AdminShellProps) {
  const styles = useStyles();
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [activeCommandIndex, setActiveCommandIndex] = useState(-1);
  const permittedNavigation = navigationItems.filter((item) =>
    hasPermission(subject, item.permission),
  );
  const permittedActions = actions.filter((action) => hasPermission(subject, action.permission));
  const normalizedCommandQuery = commandQuery.trim().toLocaleLowerCase('zh-CN');
  const commandResults = normalizedCommandQuery
    ? permittedNavigation.filter((item) =>
        item.label.toLocaleLowerCase('zh-CN').includes(normalizedCommandQuery),
      )
    : [];
  const commandListIsOpen = commandQuery.length > 0;
  const activeCommandId =
    activeCommandIndex >= 0 && commandResults[activeCommandIndex]
      ? `admin-command-option-${String(activeCommandIndex)}`
      : undefined;

  return (
    <FluentProvider theme={webLightTheme}>
      <div className={styles.root} data-testid="admin-shell">
        <div className={styles.brand}>
          <Text className={styles.brandTitle}>镜界运营控制台</Text>
          <Text className={styles.brandDomain}>admin.ai-video.internal</Text>
        </div>

        <header className={styles.header}>
          <Button
            appearance="subtle"
            aria-controls="admin-navigation"
            aria-expanded={isNavigationOpen}
            aria-label={isNavigationOpen ? '关闭导航' : '打开导航'}
            className={styles.menuButton}
            icon={<Navigation24Regular aria-hidden />}
            onClick={() => {
              setIsNavigationOpen((isOpen) => !isOpen);
            }}
          />
          <div className={styles.desktopHeaderContent}>
            <div className={styles.searchContainer}>
              <SearchBox
                aria-activedescendant={activeCommandId}
                aria-autocomplete="list"
                aria-controls={commandListIsOpen ? 'admin-command-results' : undefined}
                aria-expanded={commandListIsOpen}
                aria-label="命令搜索"
                className={styles.search}
                onChange={(_event, data) => {
                  setCommandQuery(data.value);
                  setActiveCommandIndex(-1);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setCommandQuery('');
                    setActiveCommandIndex(-1);
                    return;
                  }
                  if (
                    (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                    commandResults.length > 0
                  ) {
                    event.preventDefault();
                    setActiveCommandIndex((currentIndex) => {
                      if (event.key === 'ArrowDown') {
                        return (currentIndex + 1) % commandResults.length;
                      }
                      return currentIndex <= 0 ? commandResults.length - 1 : currentIndex - 1;
                    });
                    return;
                  }
                  if (event.key === 'Enter' && activeCommandId) {
                    event.preventDefault();
                    document
                      .getElementById(activeCommandId)
                      ?.querySelector<HTMLAnchorElement>('a')
                      ?.click();
                  }
                }}
                placeholder="搜索页面、用户、任务"
                role="combobox"
                value={commandQuery}
              />
              {commandListIsOpen ? (
                <ul
                  aria-label="命令搜索结果"
                  className={styles.searchResults}
                  id="admin-command-results"
                  role="listbox"
                >
                  {commandResults.length > 0 ? (
                    commandResults.map((item, index) => (
                      <li
                        aria-selected={activeCommandIndex === index}
                        className={styles.searchResultItem}
                        id={`admin-command-option-${String(index)}`}
                        key={item.href}
                        role="option"
                      >
                        <Link
                          className={styles.searchResultLink}
                          href={item.href}
                          onClick={() => {
                            setCommandQuery('');
                          }}
                          tabIndex={-1}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))
                  ) : (
                    <li aria-disabled="true" className={styles.emptySearchResult} role="option">
                      没有可用命令
                    </li>
                  )}
                </ul>
              ) : null}
            </div>
            <div className={styles.headerMeta}>
              <Badge appearance="tint" color="informative">
                {environment}
              </Badge>
              <Badge appearance="outline">数据范围 {dataScopeLabels[subject.dataScope]}</Badge>
              {identity ? <Badge appearance="outline">管理员 {identity}</Badge> : null}
            </div>
          </div>
        </header>

        <div aria-label="移动端管理上下文" className={styles.mobileMeta} role="region">
          <Badge appearance="tint" color="informative">
            {environment}
          </Badge>
          <Badge appearance="outline">数据范围 {dataScopeLabels[subject.dataScope]}</Badge>
          {identity ? <Badge appearance="outline">管理员 {identity}</Badge> : null}
        </div>

        <aside
          className={mergeClasses(styles.sidebar, isNavigationOpen && styles.sidebarOpen)}
          id="admin-navigation"
        >
          <nav aria-label="主导航" className={styles.navigation}>
            {permittedNavigation.map(({ href, icon: Icon, label }) => (
              <Link className={styles.navigationLink} href={href} key={href}>
                <Icon aria-hidden />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
        </aside>

        <main className={styles.main}>
          <div className={styles.contextBar}>
            <Breadcrumb aria-label="面包屑">
              {breadcrumbs.map((breadcrumb, index) => {
                const isCurrent = index === breadcrumbs.length - 1;
                return (
                  <Fragment key={`${breadcrumb.label}-${String(index)}`}>
                    {index > 0 ? <BreadcrumbDivider /> : null}
                    <BreadcrumbItem>
                      {!isCurrent ? (
                        <Link href={breadcrumb.href}>{breadcrumb.label}</Link>
                      ) : (
                        <Text aria-current="page" className={styles.currentBreadcrumb}>
                          {breadcrumb.label}
                        </Text>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </Breadcrumb>
            {permittedActions.length > 0 ? (
              <div aria-label="页面操作" className={styles.actions} role="toolbar">
                {permittedActions.map((action) => (
                  <Button key={action.label} onClick={action.onClick} size="small">
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          {children ?? (
            <section aria-labelledby="admin-empty-heading">
              <Title2 id="admin-empty-heading">运营工作台</Title2>
            </section>
          )}
        </main>
      </div>
    </FluentProvider>
  );
}
