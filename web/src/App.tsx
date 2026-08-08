import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Progress,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { CopyOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { fetchStatus, triggerTask, type TaskMode, type TaskStatus } from './api';
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

const PROXY_STORAGE_KEY = 'gpt-web-console.proxy.v2';

type ProxyStore = {
  region: string;
  /** 各地区代理链接文本（多行） */
  linksByRegion: Record<string, string>;
};

function readProxyStore(): ProxyStore {
  try {
    const raw = localStorage.getItem(PROXY_STORAGE_KEY);
    if (!raw) return { region: 'JP', linksByRegion: {} };
    const parsed = JSON.parse(raw) as ProxyStore;
    if (!parsed || typeof parsed !== 'object') return { region: 'JP', linksByRegion: {} };
    return {
      region: typeof parsed.region === 'string' && parsed.region ? parsed.region : 'JP',
      linksByRegion:
        parsed.linksByRegion && typeof parsed.linksByRegion === 'object' ? parsed.linksByRegion : {},
    };
  } catch {
    return { region: 'JP', linksByRegion: {} };
  }
}

function writeProxyStore(store: ProxyStore): void {
  localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify(store));
}

function saveProxyRegionLinks(region: string, links: string): void {
  if (!region || region === 'none') return;
  const store = readProxyStore();
  store.region = region;
  store.linksByRegion[region] = links;
  writeProxyStore(store);
}

const HOLD_MINUTES_OPTIONS = [
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
];

const PAYMENT_LINK_OPTIONS = [
  { value: '未选择', label: '未选择' },
  { value: 'gcash', label: 'gcash' },
];

/** 注册/登录共用字段；模式专属字段按需使用 */
interface TaskFormValues {
  accounts: string;
  forwarding_emails: string;
  enable_mfa: boolean;
  proxy_region: string;
  proxy_links: string;
  hold_minutes: number;
  payment_link_type: string;
  payment_card: string;
}

function isProxyEnabled(region: string | undefined): boolean {
  return Boolean(region && region !== 'none');
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
};

export default function App() {
  const [mode, setMode] = useState<TaskMode>('register');
  const [submitting, setSubmitting] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [form] = Form.useForm<TaskFormValues>();
  const paymentLinkType = Form.useWatch('payment_link_type', form);
  const proxyRegion = Form.useWatch('proxy_region', form);
  const proxyRegionRef = useRef(proxyRegion);

  useEffect(() => {
    proxyRegionRef.current = proxyRegion;
  }, [proxyRegion]);

  // 启动时恢复上次地区与对应代理链接
  useEffect(() => {
    const store = readProxyStore();
    const region = PROXY_REGION_OPTIONS.some((item) => item.value === store.region)
      ? store.region
      : 'JP';
    form.setFieldsValue({
      proxy_region: region,
      proxy_links: store.linksByRegion[region] || '',
    });
    proxyRegionRef.current = region;
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

  const onSubmit = async (values: TaskFormValues) => {
    setSubmitting(true);
    try {
      if (isProxyEnabled(values.proxy_region)) {
        saveProxyRegionLinks(values.proxy_region, values.proxy_links || '');
      } else {
        const store = readProxyStore();
        store.region = 'none';
        writeProxyStore(store);
      }
      const shared = {
        accounts: values.accounts,
        enable_711_proxy: isProxyEnabled(values.proxy_region),
        proxy_region: isProxyEnabled(values.proxy_region) ? values.proxy_region : '',
        proxy_links: isProxyEnabled(values.proxy_region) ? (values.proxy_links || '').trim() : '',
        payment_link_type: values.payment_link_type,
        payment_card: values.payment_card,
        hold_minutes: Number(values.hold_minutes) || 15,
      };
      const result =
        mode === 'register'
          ? await triggerTask({
              ...shared,
              mode: 'register',
              forwarding_emails: values.forwarding_emails,
              enable_mfa: values.enable_mfa,
            })
          : await triggerTask({
              ...shared,
              mode: 'login',
            });
      setTaskId(result.taskId);
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
          onChange={(e) => setMode(e.target.value)}
          options={[
            { label: '注册', value: 'register' },
            { label: '登录', value: 'login' },
          ]}
        />

        <Form
          form={form}
          layout="vertical"
          className="task-form"
          initialValues={{
            forwarding_emails: FORWARDING_EMAIL_OPTIONS[0].value,
            enable_mfa: true,
            proxy_region: 'JP',
            proxy_links: '',
            hold_minutes: 15,
            payment_link_type: '未选择',
            payment_card: '',
          }}
          onFinish={onSubmit}
        >
          <Form.Item
            label="账号"
            name="accounts"
            rules={[{ required: true, message: '请填写账号' }]}
            extra={
              mode === 'register'
                ? '支持单邮箱、Outlook 四字段、iCloud 两字段；多账号用换行或分号分隔'
                : '格式：email----password----2fa；第三段识别为 2FA 后忽略第四段及以后（取件链接等）'
            }
          >
            <TextArea
              rows={6}
              placeholder={
                mode === 'register'
                  ? 'email@example.com\n或 email----password----client_id----refresh_token'
                  : 'email----password----2fa'
              }
            />
          </Form.Item>

          {mode === 'register' ? (
            <Form.Item
              label="转发邮箱"
              name="forwarding_emails"
              extra="单邮箱账号收验证邮件用"
              rules={[{ required: true, message: '请选择转发邮箱' }]}
            >
              <Select options={FORWARDING_EMAIL_OPTIONS} />
            </Form.Item>
          ) : null}

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
                    saveProxyRegionLinks(prevRegion, current.proxy_links || '');
                  }
                  if (!nextRegion || nextRegion === 'none') {
                    form.setFieldsValue({ proxy_links: '' });
                    const store = readProxyStore();
                    store.region = 'none';
                    writeProxyStore(store);
                    proxyRegionRef.current = 'none';
                    return;
                  }
                  const store = readProxyStore();
                  store.region = nextRegion;
                  writeProxyStore(store);
                  form.setFieldsValue({
                    proxy_links: store.linksByRegion[nextRegion] || '',
                  });
                  proxyRegionRef.current = nextRegion;
                }}
              />
            </Form.Item>
          </Space>

          {isProxyEnabled(proxyRegion) ? (
            <Form.Item
              label="代理链接"
              name="proxy_links"
              rules={[{ required: true, message: '请填写至少一条代理链接' }]}
              extra="每行一条；多账号按顺序轮询分配（例如 5 个账号、3 条链接 → 1,2,3,1,2）。支持 http://user:pass@host:port 或 host:port:user:pass"
            >
              <TextArea
                rows={4}
                placeholder={'http://user:pass@host:10000\nhost:10000:user:pass'}
                autoComplete="off"
                onBlur={() => {
                  const values = form.getFieldsValue();
                  if (isProxyEnabled(values.proxy_region)) {
                    saveProxyRegionLinks(values.proxy_region, values.proxy_links || '');
                  }
                }}
              />
            </Form.Item>
          ) : null}

          <Form.Item label="支付提链" name="payment_link_type">
            <Select
              style={{ width: 200 }}
              options={PAYMENT_LINK_OPTIONS}
              onChange={(value) => {
                if (value !== 'gcash') form.setFieldValue('payment_card', '');
              }}
            />
          </Form.Item>
          {paymentLinkType === 'gcash' ? (
            <Form.Item label="卡密" name="payment_card" rules={[{ required: true, message: '请填写卡密' }]}>
              <Input.Password placeholder="请输入卡密" autoComplete="off" />
            </Form.Item>
          ) : null}

          <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} loading={submitting} size="large">
            {mode === 'register' ? '开始注册' : '开始登录'}
          </Button>
        </Form>
      </Card>

      {taskId && (
        <Card className="panel status-panel" bordered={false} title="处理进度">
          <Paragraph className="status-message">{status?.message || '已提交，正在启动任务，请稍候…'}</Paragraph>
          {waitingTip ? <Paragraph className="status-tip">{waitingTip}</Paragraph> : null}
          <Progress
            percent={progress}
            status={status?.phase === 'failed' ? 'exception' : status?.done ? 'success' : 'active'}
            strokeColor={{ from: '#0f766e', to: '#14b8a6' }}
          />

          {status?.accounts?.length ? (
            <div className="account-list">
              {status.accounts.map((account) => (
                <div className="account-row" key={account.index}>
                  <div className="account-meta">
                    <Text strong>{account.email}</Text>
                    <Text type={account.ok === true ? 'success' : account.ok === false ? 'danger' : 'secondary'}>
                      {account.ok === true ? '完成' : account.ok === false ? account.error || '失败' : '处理中…'}
                    </Text>
                  </div>
                  {account.hint ? <Paragraph className="account-hint">{account.hint}</Paragraph> : null}
                  {account.accessToken ? (
                    <Space.Compact className="token-box">
                      <Input value={account.accessToken} readOnly />
                      <Button icon={<CopyOutlined />} onClick={() => void copyText(account.accessToken!)}>
                        复制
                      </Button>
                    </Space.Compact>
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
                            <img src={account.paymentQr} alt="支付二维码" width={168} height={168} />
                          </div>
                        </>
                      ) : null}
                      {account.paymentQrUrl ? (
                        <>
                          <Text strong>二维码链接</Text>
                          <Space.Compact className="token-box">
                            <Input value={account.paymentQrUrl} readOnly />
                            <Button
                              icon={<CopyOutlined />}
                              onClick={() => void copyText(account.paymentQrUrl!, '已复制二维码链接')}
                            >
                              复制
                            </Button>
                          </Space.Compact>
                        </>
                      ) : null}
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
