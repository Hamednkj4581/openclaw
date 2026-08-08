import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { CopyOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons';
import { cancelTask, fetchHeroSmsMeta, fetchStatus, triggerTask, type HeroSmsCountry, type HeroSmsService, type ProgressLogEntry, type TaskMode, type TaskStatus } from './api';
import './App.css';

const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

const FORWARDING_EMAIL_OPTIONS = [{ value: 'TimmothyBegan9059@hotmail.com', label: 'TimmothyBegan9059@hotmail.com' }];

/** 代理地区：none=直连；后续可扩展更多地区码 */
const PROXY_REGION_OPTIONS = [
  { value: 'none', label: '直连（不使用代理）' },
  { value: 'JP', label: '日本' },
  { value: 'PH', label: '菲律宾' },
];

const PROXY_TYPE_OPTIONS = [
  { value: '711', label: '711Proxy 账号' },
  { value: 'links', label: '自定义代理链接' },
];

const PROXY_STORAGE_KEY = 'gpt-web-console.proxy.v3';
const PROXY_STORAGE_KEY_V2 = 'gpt-web-console.proxy.v2';
const SETTINGS_STORAGE_KEY = 'gpt-web-console.settings.v1';

type ProxyType = '711' | 'links';
type ProxyCreds = { username: string; password: string };
type ProxyStore = {
  region: string;
  /** 各地区代理方式 */
  typeByRegion: Record<string, ProxyType>;
  /** 711 账号密码（按地区） */
  credentials: Record<string, ProxyCreds>;
  /** 各地区代理链接文本（多行） */
  linksByRegion: Record<string, string>;
};

/** 除账号输入外的表单设置（浏览器本地持久化） */
type PersistedSettings = {
  mode: TaskMode;
  forwarding_emails: string;
  enable_mfa: boolean;
  hold_minutes: number;
  payment_link_type: string;
  payment_card: string;
  gc_ph_api_key: string;
  hero_sms_api_key: string;
  hero_sms_service: string;
  hero_sms_country: string;
};

const DEFAULT_SETTINGS: PersistedSettings = {
  mode: 'register',
  forwarding_emails: FORWARDING_EMAIL_OPTIONS[0].value,
  enable_mfa: true,
  hold_minutes: 15,
  payment_link_type: '未选择',
  payment_card: '',
  gc_ph_api_key: '',
  hero_sms_api_key: '',
  hero_sms_service: '',
  hero_sms_country: '',
};

function emptyProxyStore(region = 'JP'): ProxyStore {
  return { region, typeByRegion: {}, credentials: {}, linksByRegion: {} };
}

function normalizeProxyType(value: unknown): ProxyType {
  return value === 'links' ? 'links' : '711';
}

function readProxyStore(): ProxyStore {
  try {
    const raw = localStorage.getItem(PROXY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProxyStore>;
      if (!parsed || typeof parsed !== 'object') return emptyProxyStore();
      const typeByRegion: Record<string, ProxyType> = {};
      if (parsed.typeByRegion && typeof parsed.typeByRegion === 'object') {
        for (const [key, value] of Object.entries(parsed.typeByRegion)) {
          typeByRegion[key] = normalizeProxyType(value);
        }
      }
      const credentials: Record<string, ProxyCreds> = {};
      if (parsed.credentials && typeof parsed.credentials === 'object') {
        for (const [key, value] of Object.entries(parsed.credentials)) {
          if (!value || typeof value !== 'object') continue;
          credentials[key] = {
            username: typeof value.username === 'string' ? value.username : '',
            password: typeof value.password === 'string' ? value.password : '',
          };
        }
      }
      return {
        region: typeof parsed.region === 'string' && parsed.region ? parsed.region : 'JP',
        typeByRegion,
        credentials,
        linksByRegion:
          parsed.linksByRegion && typeof parsed.linksByRegion === 'object' ? parsed.linksByRegion : {},
      };
    }

    // 兼容 v2：仅有 linksByRegion
    const legacyRaw = localStorage.getItem(PROXY_STORAGE_KEY_V2);
    if (!legacyRaw) return emptyProxyStore();
    const legacy = JSON.parse(legacyRaw) as { region?: string; linksByRegion?: Record<string, string> };
    const linksByRegion =
      legacy.linksByRegion && typeof legacy.linksByRegion === 'object' ? legacy.linksByRegion : {};
    const typeByRegion: Record<string, ProxyType> = {};
    for (const region of Object.keys(linksByRegion)) {
      if ((linksByRegion[region] || '').trim()) typeByRegion[region] = 'links';
    }
    const migrated = emptyProxyStore(
      typeof legacy.region === 'string' && legacy.region ? legacy.region : 'JP',
    );
    migrated.linksByRegion = linksByRegion;
    migrated.typeByRegion = typeByRegion;
    writeProxyStore(migrated);
    return migrated;
  } catch {
    return emptyProxyStore();
  }
}

function writeProxyStore(store: ProxyStore): void {
  localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify(store));
}

function saveProxyRegionState(
  region: string,
  patch: { type?: ProxyType; username?: string; password?: string; links?: string },
): void {
  if (!region || region === 'none') return;
  const store = readProxyStore();
  store.region = region;
  if (patch.type) store.typeByRegion[region] = patch.type;
  if (patch.username !== undefined || patch.password !== undefined) {
    const prev = store.credentials[region] || { username: '', password: '' };
    store.credentials[region] = {
      username: patch.username !== undefined ? patch.username.trim() : prev.username,
      password: patch.password !== undefined ? patch.password : prev.password,
    };
  }
  if (patch.links !== undefined) store.linksByRegion[region] = patch.links;
  writeProxyStore(store);
}

function readSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
    const hold = Number(parsed.hold_minutes);
    return {
      mode:
        parsed.mode === 'login' || parsed.mode === 'register' || parsed.mode === 'bind_phone'
          ? parsed.mode
          : DEFAULT_SETTINGS.mode,
      forwarding_emails:
        typeof parsed.forwarding_emails === 'string' && parsed.forwarding_emails
          ? parsed.forwarding_emails
          : DEFAULT_SETTINGS.forwarding_emails,
      enable_mfa: typeof parsed.enable_mfa === 'boolean' ? parsed.enable_mfa : DEFAULT_SETTINGS.enable_mfa,
      hold_minutes: [0, 5, 10, 15, 30].includes(hold) ? hold : DEFAULT_SETTINGS.hold_minutes,
      payment_link_type:
        parsed.payment_link_type === 'gcash' || parsed.payment_link_type === '未选择'
          ? parsed.payment_link_type
          : DEFAULT_SETTINGS.payment_link_type,
      payment_card: typeof parsed.payment_card === 'string' ? parsed.payment_card : '',
      gc_ph_api_key: typeof parsed.gc_ph_api_key === 'string' ? parsed.gc_ph_api_key : '',
      hero_sms_api_key: typeof parsed.hero_sms_api_key === 'string' ? parsed.hero_sms_api_key : '',
      hero_sms_service: typeof parsed.hero_sms_service === 'string' ? parsed.hero_sms_service : '',
      hero_sms_country: typeof parsed.hero_sms_country === 'string' ? parsed.hero_sms_country : '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch: Partial<PersistedSettings>): void {
  const next = { ...readSettings(), ...patch };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
}

const HOLD_MINUTES_OPTIONS = [
  { value: 0, label: '0 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
];

const PAYMENT_LINK_OPTIONS = [
  { value: '未选择', label: '未选择' },
  { value: 'gcash', label: 'gcash' },
];

/** 注册/登录/绑定手机共用字段 */
interface TaskFormValues {
  accounts: string;
  forwarding_emails: string;
  enable_mfa: boolean;
  proxy_region: string;
  proxy_type: ProxyType;
  proxy_username: string;
  proxy_password: string;
  proxy_links: string;
  hold_minutes: number;
  payment_link_type: string;
  payment_card: string;
  gc_ph_api_key: string;
  hero_sms_api_key: string;
  hero_sms_service: string;
  hero_sms_country: string;
}

function isProxyEnabled(region: string | undefined): boolean {
  return Boolean(region && region !== 'none');
}

function persistFormSettings(values: Partial<TaskFormValues>, mode: TaskMode): void {
  const hold = Number(values.hold_minutes);
  writeSettings({
    mode,
    ...(typeof values.forwarding_emails === 'string' && values.forwarding_emails
      ? { forwarding_emails: values.forwarding_emails }
      : {}),
    ...(typeof values.enable_mfa === 'boolean' ? { enable_mfa: values.enable_mfa } : {}),
    ...([0, 5, 10, 15, 30].includes(hold) ? { hold_minutes: hold } : {}),
    ...(values.payment_link_type === 'gcash' || values.payment_link_type === '未选择'
      ? { payment_link_type: values.payment_link_type }
      : {}),
    ...(typeof values.payment_card === 'string' ? { payment_card: values.payment_card } : {}),
    ...(typeof values.gc_ph_api_key === 'string' ? { gc_ph_api_key: values.gc_ph_api_key } : {}),
    ...(typeof values.hero_sms_api_key === 'string' ? { hero_sms_api_key: values.hero_sms_api_key } : {}),
    ...(typeof values.hero_sms_service === 'string' ? { hero_sms_service: values.hero_sms_service } : {}),
    ...(typeof values.hero_sms_country === 'string' ? { hero_sms_country: values.hero_sms_country } : {}),
  });
  if (isProxyEnabled(values.proxy_region)) {
    saveProxyRegionState(values.proxy_region!, {
      type: values.proxy_type === 'links' ? 'links' : '711',
      username: values.proxy_username || '',
      password: values.proxy_password || '',
      links: values.proxy_links || '',
    });
  } else if (values.proxy_region === 'none') {
    const store = readProxyStore();
    store.region = 'none';
    writeProxyStore(store);
  }
}

function formatRemain(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function useHoldCountdown(holdUntil?: number): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!holdUntil || holdUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [holdUntil]);

  if (!holdUntil) return null;
  const remain = holdUntil - now;
  if (remain <= 0) return null;
  return formatRemain(remain);
}

function AccountHoldCountdown({ holdUntil }: { holdUntil?: number }) {
  const label = useHoldCountdown(holdUntil);
  if (!label) return null;
  return <div className="hold-countdown">保持中，剩余 {label}</div>;
}

function formatLogTime(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ProgressLogDetails({ logs, title = '详情' }: { logs?: ProgressLogEntry[]; title?: string }) {
  if (!logs?.length) return null;
  return (
    <Collapse
      className="progress-log-collapse"
      ghost
      size="small"
      items={[
        {
          key: 'logs',
          label: `${title}（${logs.length}）`,
          children: (
            <div className="progress-log-list">
              {logs.map((log, index) => (
                <div className="progress-log-line" key={`${log.at}-${index}`}>
                  <span className="progress-log-time">{formatLogTime(log.at)}</span>
                  <span className="progress-log-message">{log.message}</span>
                </div>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

/** 等待期间轮换的友好提示（不含技术细节） */
const WAITING_TIPS = [
  '处理时间可能较长，请耐心等待',
  '正在安全处理中，请勿关闭本页面',
  '仍在进行，马上就好',
  '账号较多或网络较慢时会多等一会儿',
  '完成后结果会自动显示在下方',
];

function useWaitingTip(active: boolean): string | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 8000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return WAITING_TIPS[tick % WAITING_TIPS.length];
}

const phasePercent: Record<TaskStatus['phase'], number> = {
  submitted: 8,
  processing: 55,
  done: 100,
  failed: 100,
  cancelled: 100,
};

export default function App() {
  const savedSettings = useMemo(() => readSettings(), []);
  const [mode, setMode] = useState<TaskMode>(savedSettings.mode);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [runName, setRunName] = useState<string | null>(null);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [form] = Form.useForm<TaskFormValues>();
  const paymentLinkType = Form.useWatch('payment_link_type', form);
  const proxyRegion = Form.useWatch('proxy_region', form);
  const proxyType = Form.useWatch('proxy_type', form);
  const proxyRegionRef = useRef(proxyRegion);
  const [heroSmsCountries, setHeroSmsCountries] = useState<HeroSmsCountry[]>([]);
  const [heroSmsServices, setHeroSmsServices] = useState<HeroSmsService[]>([]);
  const [heroSmsLoading, setHeroSmsLoading] = useState(false);

  useEffect(() => {
    proxyRegionRef.current = proxyRegion;
  }, [proxyRegion]);

  // 启动时恢复本地设置（不含账号输入）
  useEffect(() => {
    const settings = readSettings();
    const store = readProxyStore();
    const resolvedRegion = PROXY_REGION_OPTIONS.some((item) => item.value === store.region)
      ? store.region
      : 'JP';
    const resolvedType =
      resolvedRegion === 'none'
        ? '711'
        : normalizeProxyType(store.typeByRegion[resolvedRegion] || (store.linksByRegion[resolvedRegion] ? 'links' : '711'));
    const creds = store.credentials[resolvedRegion] || { username: '', password: '' };
    form.setFieldsValue({
      forwarding_emails: settings.forwarding_emails,
      enable_mfa: settings.enable_mfa,
      hold_minutes: settings.hold_minutes,
      payment_link_type: settings.payment_link_type,
      payment_card: settings.payment_card,
      gc_ph_api_key: settings.gc_ph_api_key,
      hero_sms_api_key: settings.hero_sms_api_key,
      hero_sms_service: settings.hero_sms_service,
      hero_sms_country: settings.hero_sms_country,
      proxy_region: resolvedRegion,
      proxy_type: resolvedType,
      proxy_username: resolvedRegion === 'none' ? '' : creds.username || '',
      proxy_password: resolvedRegion === 'none' ? '' : creds.password || '',
      proxy_links: resolvedRegion === 'none' ? '' : store.linksByRegion[resolvedRegion] || '',
    });
    proxyRegionRef.current = resolvedRegion;
    setMode(settings.mode);
  }, [form]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await fetchStatus(taskId);
        if (cancelled) return;
        setStatus(next);
        if (next.runName) setRunName(next.runName);
        if (!next.done) {
          timer = window.setTimeout(tick, 2500);
        }
      } catch (error) {
        if (cancelled) return;
        message.error(error instanceof Error ? error.message : '查询进度失败');
        timer = window.setTimeout(tick, 4000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [taskId]);

  const progress = useMemo(() => {
    if (!status) return 0;
    if (status.total > 0) {
      return Math.min(100, Math.round((status.doneCount / status.total) * 100));
    }
    return phasePercent[status.phase];
  }, [status]);

  const waiting = Boolean(taskId && (!status || !status.done));
  const waitingTip = useWaitingTip(waiting);
  const submitBusy = submitting || waiting;

  const allCredentialLines = useMemo(() => {
    const rows = status?.accounts || [];
    return rows
      .map((account) => {
        const email = (account.email || '').trim();
        const password = (account.password || '').trim();
        if (!email || !password) return '';
        const otp = (account.otpSecret || '').trim();
        const token = (account.accessToken || '').trim();
        return [email, password, ...(otp ? [otp] : []), ...(token ? [token] : [])].join('----');
      })
      .filter(Boolean);
  }, [status]);

  const onSubmit = async (values: TaskFormValues) => {
    setSubmitting(true);
    try {
      persistFormSettings(values, mode);
      const proxyEnabled = isProxyEnabled(values.proxy_region);
      const use711 = proxyEnabled && values.proxy_type !== 'links';
      const shared = {
        accounts: values.accounts,
        enable_711_proxy: proxyEnabled,
        proxy_region: proxyEnabled ? values.proxy_region : '',
        proxy_username: use711 ? (values.proxy_username || '').trim() : '',
        proxy_password: use711 ? values.proxy_password || '' : '',
        proxy_links: proxyEnabled && !use711 ? (values.proxy_links || '').trim() : '',
        hold_minutes: [0, 5, 10, 15, 30].includes(Number(values.hold_minutes))
          ? Number(values.hold_minutes)
          : 15,
      };
      const result =
        mode === 'register'
          ? await triggerTask({
              ...shared,
              mode: 'register',
              forwarding_emails: values.forwarding_emails,
              enable_mfa: values.enable_mfa,
              payment_link_type: values.payment_link_type,
              payment_card: values.payment_card,
              gc_ph_api_key: values.payment_link_type === 'gcash' ? values.gc_ph_api_key || '' : '',
            })
          : mode === 'bind_phone'
            ? await triggerTask({
                ...shared,
                mode: 'bind_phone',
                forwarding_emails: values.forwarding_emails,
                hero_sms_api_key: values.hero_sms_api_key || '',
                hero_sms_service: values.hero_sms_service || '',
                hero_sms_country: values.hero_sms_country || '',
              })
            : await triggerTask({
                ...shared,
                mode: 'login',
                forwarding_emails: values.forwarding_emails,
                payment_link_type: values.payment_link_type,
                payment_card: values.payment_card,
                gc_ph_api_key: values.payment_link_type === 'gcash' ? values.gc_ph_api_key || '' : '',
              });
      setTaskId(result.taskId);
      setRunName(result.runName || null);
      setStatus(null);
      message.success('已提交');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const copyText = async (text: string, okMessage = '已复制') => {
    await navigator.clipboard.writeText(text);
    message.success(okMessage);
  };

  const loadHeroSmsMeta = async () => {
    const apiKey = (form.getFieldValue('hero_sms_api_key') || '').trim();
    if (!apiKey) {
      message.warning('请先填写 Hero SMS API Key');
      return;
    }
    const countryRaw = form.getFieldValue('hero_sms_country');
    const country = countryRaw === '' || countryRaw === undefined ? undefined : Number(countryRaw);
    setHeroSmsLoading(true);
    try {
      const meta = await fetchHeroSmsMeta(apiKey, Number.isInteger(country) ? country : undefined);
      setHeroSmsCountries(meta.countries);
      setHeroSmsServices(meta.services);
      message.success('已加载 Hero SMS 国家与服务列表');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载 Hero SMS 列表失败');
    } finally {
      setHeroSmsLoading(false);
    }
  };

  const onCancelTask = () => {
    if (!taskId || !waiting) return;
    Modal.confirm({
      title: '取消当前任务？',
      content: '进行中的账号会中止。',
      okText: '确认取消',
      okButtonProps: { danger: true },
      cancelText: '返回',
      onOk: async () => {
        setCancelling(true);
        try {
          const result = await cancelTask(taskId);
          message.success(result.message || '已取消');
          const next = await fetchStatus(taskId);
          setStatus(next);
          if (next.runName) setRunName(next.runName);
        } catch (error) {
          message.error(error instanceof Error ? error.message : '取消失败');
          throw error;
        } finally {
          setCancelling(false);
        }
      },
    });
  };

  const copyAllCredentialLines = async () => {
    if (!allCredentialLines.length) {
      message.warning('暂无账号密码可复制');
      return;
    }
    await copyText(allCredentialLines.join('\n'), `已复制 ${allCredentialLines.length} 条账号结果`);
  };

  const formatAccountLine = (account: {
    email: string;
    password?: string;
    otpSecret?: string;
    accessToken?: string;
  }) => {
    const email = (account.email || '').trim();
    const password = (account.password || '').trim();
    if (!email || !password) return '';
    const otp = (account.otpSecret || '').trim();
    const token = (account.accessToken || '').trim();
    return [email, password, ...(otp ? [otp] : []), ...(token ? [token] : [])].join('----');
  };

  return (
    <div className="page">
      <header className="hero">
        <p className="brand">控制台</p>
        <Title level={2} className="hero-title">
          账号处理台
        </Title>
      </header>

      <Card className="panel" bordered={false}>
        <Radio.Group
          className="mode-switch"
          optionType="button"
          buttonStyle="solid"
          value={mode}
          disabled={waiting || cancelling}
          onChange={(e) => {
            const next = e.target.value as TaskMode;
            setMode(next);
            writeSettings({ mode: next });
          }}
          options={[
            { label: '注册', value: 'register' },
            { label: '登录', value: 'login' },
            { label: '绑定手机', value: 'bind_phone' },
          ]}
        />

        <Form
          form={form}
          layout="vertical"
          className="task-form"
          disabled={waiting || cancelling}
          initialValues={{
            forwarding_emails: savedSettings.forwarding_emails,
            enable_mfa: savedSettings.enable_mfa,
            proxy_region: 'JP',
            proxy_type: '711',
            proxy_username: '',
            proxy_password: '',
            proxy_links: '',
            hold_minutes: savedSettings.hold_minutes,
            payment_link_type: savedSettings.payment_link_type,
            payment_card: savedSettings.payment_card,
            gc_ph_api_key: savedSettings.gc_ph_api_key,
            hero_sms_api_key: savedSettings.hero_sms_api_key,
            hero_sms_service: savedSettings.hero_sms_service,
            hero_sms_country: savedSettings.hero_sms_country,
          }}
          onValuesChange={(_, all) => {
            if (waiting) return;
            persistFormSettings(all, mode);
          }}
          onFinish={onSubmit}
        >
          <Form.Item
            label="账号"
            name="accounts"
            rules={[{ required: true, message: '请填写账号' }]}
            extra={
              mode === 'register'
                ? '单邮箱、email----取件链接、Outlook 四字段；多账号用换行或分号分隔'
                : '与注册相同，另支持 email----password----2fa'
            }
          >
            <TextArea
              rows={6}
              placeholder={
                mode === 'register'
                  ? 'email@example.com\n或 email----取件链接'
                  : 'email----取件链接\n或 email----password----2fa'
              }
            />
          </Form.Item>

          {mode === 'bind_phone' ? (
            <>
              <Form.Item
                label="Hero SMS API Key"
                name="hero_sms_api_key"
                rules={[{ required: true, message: '请填写 Hero SMS API Key' }]}
              >
                <Input.Password placeholder="Hero SMS API Key" autoComplete="off" />
              </Form.Item>
              <Form.Item label="接码配置">
                <Space wrap>
                  <Button loading={heroSmsLoading} onClick={() => void loadHeroSmsMeta()}>
                    加载国家与服务
                  </Button>
                  <Text type="secondary">先填 API Key，可选国家后再加载服务列表</Text>
                </Space>
              </Form.Item>
              <Form.Item
                label="国家"
                name="hero_sms_country"
                rules={[{ required: true, message: '请选择国家' }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  style={{ width: 320 }}
                  placeholder="请先加载列表"
                  options={heroSmsCountries.map((row) => ({
                    value: String(row.id),
                    label: `${row.name} (${row.id})`,
                  }))}
                  onChange={(value) => {
                    form.setFieldValue('hero_sms_service', '');
                    const apiKey = (form.getFieldValue('hero_sms_api_key') || '').trim();
                    if (!apiKey || !value) return;
                    void (async () => {
                      setHeroSmsLoading(true);
                      try {
                        const meta = await fetchHeroSmsMeta(apiKey, Number(value));
                        setHeroSmsCountries(meta.countries);
                        setHeroSmsServices(meta.services);
                      } catch (error) {
                        message.error(error instanceof Error ? error.message : '刷新服务列表失败');
                      } finally {
                        setHeroSmsLoading(false);
                      }
                    })();
                  }}
                />
              </Form.Item>
              <Form.Item
                label="服务"
                name="hero_sms_service"
                rules={[{ required: true, message: '请选择服务' }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  style={{ width: 320 }}
                  placeholder="请先加载列表"
                  options={heroSmsServices.map((row) => ({
                    value: row.code,
                    label: `${row.name} (${row.code})`,
                  }))}
                />
              </Form.Item>
            </>
          ) : null}

          <Form.Item
            label="转发邮箱"
            name="forwarding_emails"
            extra={
              mode === 'register'
                ? '单邮箱账号收验证邮件用'
                : '无行内取件时，登录/绑定收邮箱验证码用（可选）'
            }
            rules={mode === 'register' ? [{ required: true, message: '请选择转发邮箱' }] : []}
          >
            <Select options={FORWARDING_EMAIL_OPTIONS} allowClear={mode !== 'register'} />
          </Form.Item>

          <Space size="large" wrap className="switches">
            {mode === 'register' ? (
              <Form.Item label="开启两步验证" name="enable_mfa" valuePropName="checked">
                <Switch />
              </Form.Item>
            ) : null}
            <Form.Item label="延迟关闭" name="hold_minutes" rules={[{ required: true, message: '请选择延迟关闭时间' }]}>
              <Select style={{ width: 140 }} options={HOLD_MINUTES_OPTIONS} />
            </Form.Item>
            <Form.Item label="代理地区" name="proxy_region" rules={[{ required: true, message: '请选择代理地区' }]}>
              <Select
                style={{ width: 200 }}
                options={PROXY_REGION_OPTIONS}
                onChange={(nextRegion) => {
                  const current = form.getFieldsValue();
                  const prevRegion = proxyRegionRef.current;
                  if (prevRegion && prevRegion !== 'none') {
                    saveProxyRegionState(prevRegion, {
                      type: current.proxy_type === 'links' ? 'links' : '711',
                      username: current.proxy_username || '',
                      password: current.proxy_password || '',
                      links: current.proxy_links || '',
                    });
                  }
                  if (!nextRegion || nextRegion === 'none') {
                    form.setFieldsValue({
                      proxy_type: '711',
                      proxy_username: '',
                      proxy_password: '',
                      proxy_links: '',
                    });
                    const store = readProxyStore();
                    store.region = 'none';
                    writeProxyStore(store);
                    proxyRegionRef.current = 'none';
                    return;
                  }
                  const store = readProxyStore();
                  store.region = nextRegion;
                  writeProxyStore(store);
                  const nextType = normalizeProxyType(
                    store.typeByRegion[nextRegion] || (store.linksByRegion[nextRegion] ? 'links' : '711'),
                  );
                  const creds = store.credentials[nextRegion] || { username: '', password: '' };
                  form.setFieldsValue({
                    proxy_type: nextType,
                    proxy_username: creds.username || '',
                    proxy_password: creds.password || '',
                    proxy_links: store.linksByRegion[nextRegion] || '',
                  });
                  proxyRegionRef.current = nextRegion;
                }}
              />
            </Form.Item>
          </Space>

          {isProxyEnabled(proxyRegion) ? (
            <>
              <Form.Item
                label="代理方式"
                name="proxy_type"
                rules={[{ required: true, message: '请选择代理方式' }]}
              >
                <Select
                  style={{ width: 280 }}
                  options={PROXY_TYPE_OPTIONS}
                  onChange={(nextType: ProxyType) => {
                    const values = form.getFieldsValue();
                    if (isProxyEnabled(values.proxy_region)) {
                      saveProxyRegionState(values.proxy_region, { type: nextType });
                    }
                  }}
                />
              </Form.Item>
              {proxyType === 'links' ? (
                <Form.Item
                  label="代理链接"
                  name="proxy_links"
                  rules={[{ required: true, message: '请填写至少一条代理链接' }]}
                  extra="每行一条；多账号按顺序轮询分配。支持 user:pass@host:port、http://user:pass@host:port 或 host:port:user:pass"
                >
                  <TextArea
                    rows={4}
                    placeholder={'user:pass@global.rotgb.711proxy.com:10000\nhttp://user:pass@host:10000'}
                    autoComplete="off"
                    onBlur={() => {
                      const values = form.getFieldsValue();
                      if (isProxyEnabled(values.proxy_region)) {
                        saveProxyRegionState(values.proxy_region, {
                          type: 'links',
                          links: values.proxy_links || '',
                        });
                      }
                    }}
                  />
                </Form.Item>
              ) : (
                <>
                  <Form.Item
                    label="代理账号"
                    name="proxy_username"
                    rules={[{ required: true, message: '请填写代理账号' }]}
                    extra="按地区保存在本浏览器"
                  >
                    <Input
                      placeholder="711Proxy 用户名"
                      autoComplete="off"
                      onBlur={() => {
                        const values = form.getFieldsValue();
                        if (isProxyEnabled(values.proxy_region)) {
                          saveProxyRegionState(values.proxy_region, {
                            type: '711',
                            username: values.proxy_username || '',
                            password: values.proxy_password || '',
                          });
                        }
                      }}
                    />
                  </Form.Item>
                  <Form.Item
                    label="代理密码"
                    name="proxy_password"
                    rules={[{ required: true, message: '请填写代理密码' }]}
                  >
                    <Input.Password
                      placeholder="711Proxy 密码"
                      autoComplete="off"
                      onBlur={() => {
                        const values = form.getFieldsValue();
                        if (isProxyEnabled(values.proxy_region)) {
                          saveProxyRegionState(values.proxy_region, {
                            type: '711',
                            username: values.proxy_username || '',
                            password: values.proxy_password || '',
                          });
                        }
                      }}
                    />
                  </Form.Item>
                </>
              )}
            </>
          ) : null}

          {mode !== 'bind_phone' ? (
            <>
          <Form.Item label="支付提链" name="payment_link_type">
            <Select
              style={{ width: 200 }}
              options={PAYMENT_LINK_OPTIONS}
              onChange={(value) => {
                if (value !== 'gcash') {
                  form.setFieldValue('payment_card', '');
                  form.setFieldValue('gc_ph_api_key', '');
                }
              }}
            />
          </Form.Item>
          {paymentLinkType === 'gcash' ? (
            <>
              <Form.Item label="卡密" name="payment_card" rules={[{ required: true, message: '请填写卡密' }]}>
                <Input.Password placeholder="请输入卡密" autoComplete="off" />
              </Form.Item>
              <Form.Item
                label="支付通道密钥"
                name="gc_ph_api_key"
                extra="选填。填写后会把支付二维码提交到对方通道并跟踪进度；不填则跳过。"
              >
                <Input.Password placeholder="不填则跳过提交" autoComplete="off" />
              </Form.Item>
            </>
          ) : null}
            </>
          ) : null}

          <Space wrap className="submit-row">
            <Button
              type="primary"
              htmlType="submit"
              icon={<PlayCircleOutlined />}
              loading={submitBusy}
              disabled={waiting || cancelling}
              size="large"
            >
              {waiting
                ? '任务进行中…'
                : mode === 'register'
                  ? '开始注册'
                  : mode === 'bind_phone'
                    ? '开始绑定'
                    : '开始登录'}
            </Button>
          </Space>
        </Form>
        {waiting ? (
          <div className="submit-row">
            <Button
              danger
              icon={<StopOutlined />}
              loading={cancelling}
              disabled={cancelling}
              size="large"
              onClick={onCancelTask}
            >
              取消任务
            </Button>
          </div>
        ) : null}
      </Card>

      {taskId && (
        <Card className="panel status-panel" bordered={false} title="处理进度">
          <div className="task-id-box">
            <Text strong>任务 ID</Text>
            <Space.Compact className="token-box">
              <Input value={runName || status?.runName || '生成中…'} readOnly />
              <Button
                icon={<CopyOutlined />}
                disabled={!runName && !status?.runName}
                onClick={() => void copyText(runName || status?.runName || '', '已复制任务 ID')}
              >
                复制
              </Button>
            </Space.Compact>
          </div>
          <Paragraph className="status-message">{status?.message || '已提交，正在启动任务，请稍候…'}</Paragraph>
          {waitingTip ? <Paragraph className="status-tip">{waitingTip}</Paragraph> : null}
          <Progress
            percent={progress}
            status={
              status?.phase === 'failed' || status?.phase === 'cancelled'
                ? 'exception'
                : status?.done
                  ? 'success'
                  : 'active'
            }
            strokeColor={{ from: '#0f766e', to: '#14b8a6' }}
          />
          <ProgressLogDetails logs={status?.logs} title="任务详情" />
          {allCredentialLines.length > 0 ? (
            <div className="bulk-copy-row">
              <Button icon={<CopyOutlined />} onClick={() => void copyAllCredentialLines()}>
                复制全部账号结果（{allCredentialLines.length}）
              </Button>
            </div>
          ) : null}

          {status?.accounts?.length ? (
            <div className="account-list">
              {status.accounts.map((account) => (
                <div className="account-row" key={account.index}>
                  <div className="account-meta">
                    <Text strong>{account.email}</Text>
                    <Text type={account.ok === true ? 'success' : account.ok === false ? 'danger' : 'secondary'}>
                      {account.ok === true ? '完成' : account.ok === false ? '失败' : '处理中…'}
                    </Text>
                  </div>
                  {account.ok === false && account.error ? (
                    <Paragraph className="account-payment-error">{account.error}</Paragraph>
                  ) : null}
                  {account.hint ? <Paragraph className="account-hint">{account.hint}</Paragraph> : null}
                  {account.paymentError ? (
                    <Paragraph className="account-payment-error">{account.paymentError}</Paragraph>
                  ) : null}
                  <ProgressLogDetails logs={account.logs} />
                  {account.password ? (
                    <div className="cred-box">
                      <Text strong>密码</Text>
                      <Space.Compact className="token-box">
                        <Input value={account.password} readOnly />
                        <Button icon={<CopyOutlined />} onClick={() => void copyText(account.password!, '已复制密码')}>
                          复制
                        </Button>
                      </Space.Compact>
                    </div>
                  ) : null}
                  {account.otpSecret ? (
                    <div className="cred-box">
                      <Text strong>2FA</Text>
                      <Space.Compact className="token-box">
                        <Input value={account.otpSecret} readOnly />
                        <Button icon={<CopyOutlined />} onClick={() => void copyText(account.otpSecret!, '已复制 2FA')}>
                          复制
                        </Button>
                      </Space.Compact>
                    </div>
                  ) : null}
                  {account.phoneNumber ? (
                    <div className="cred-box">
                      <Text strong>手机号</Text>
                      <Space.Compact className="token-box">
                        <Input value={account.phoneNumber} readOnly />
                        <Button icon={<CopyOutlined />} onClick={() => void copyText(account.phoneNumber!, '已复制手机号')}>
                          复制
                        </Button>
                      </Space.Compact>
                    </div>
                  ) : null}
                  {account.phoneBindError ? (
                    <Paragraph className="account-payment-error">{account.phoneBindError}</Paragraph>
                  ) : null}
                  {account.accessToken ? (
                    <div className="cred-box">
                      <Text strong>accessToken</Text>
                      <Space.Compact className="token-box">
                        <Input value={account.accessToken} readOnly />
                        <Button icon={<CopyOutlined />} onClick={() => void copyText(account.accessToken!)}>
                          复制
                        </Button>
                      </Space.Compact>
                    </div>
                  ) : null}
                  {account.cookiesJson ? (
                    <div className="cred-box">
                      <Collapse
                        className="cookie-json-collapse"
                        ghost
                        size="small"
                        expandIconPosition="end"
                        defaultActiveKey={[]}
                        items={[
                          {
                            key: 'json',
                            label: (
                              <span className="cred-label-row">
                                <Button
                                  size="small"
                                  icon={<CopyOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void copyText(account.cookiesJson!, '已复制 Cookie JSON');
                                  }}
                                >
                                  复制
                                </Button>
                                <Text strong>Cookie JSON</Text>
                              </span>
                            ),
                            children: (
                              <Input.TextArea
                                value={account.cookiesJson}
                                readOnly
                                autoSize={{ minRows: 3, maxRows: 8 }}
                              />
                            ),
                          },
                        ]}
                      />
                    </div>
                  ) : null}
                  {account.password ? (
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      style={{ marginBottom: 10 }}
                      onClick={() => {
                        const line = formatAccountLine(account);
                        if (!line) return;
                        void copyText(line, '已复制账号结果行');
                      }}
                    >
                      复制本账号结果行
                    </Button>
                  ) : null}
                  {account.paymentLink ? (
                    <div className="payment-box">
                      <Text strong>支付页链接</Text>
                      <Space.Compact className="token-box">
                        <Input value={account.paymentLink} readOnly />
                        <Button icon={<CopyOutlined />} onClick={() => void copyText(account.paymentLink!, '已复制支付页链接')}>
                          复制
                        </Button>
                      </Space.Compact>
                      {account.paymentQr ? (
                        <>
                          <Text strong>支付二维码</Text>
                          <div className="payment-qr">
                            <img src={account.paymentQr} alt="支付二维码" />
                          </div>
                        </>
                      ) : (
                        <Text type="secondary">支付链接已就绪，二维码图片未获取到</Text>
                      )}
                    </div>
                  ) : null}
                  <AccountHoldCountdown holdUntil={account.holdUntil} />
                </div>
              ))}
            </div>
          ) : (
            <Alert type="info" showIcon message="任务已提交，正在启动，请稍候…" style={{ marginTop: 16 }} />
          )}
        </Card>
      )}
    </div>
  );
}
