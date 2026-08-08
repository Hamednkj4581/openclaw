import { useEffect, useMemo, useState } from 'react';
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
];

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

interface RegisterForm {
  accounts: string;
  forwarding_emails: string;
  enable_mfa: boolean;
  proxy_region: string;
  payment_link_type: string;
  payment_card: string;
}

interface LoginForm {
  accounts: string;
  proxy_region: string;
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
  const [registerForm] = Form.useForm<RegisterForm>();
  const [loginForm] = Form.useForm<LoginForm>();
  const registerPaymentType = Form.useWatch('payment_link_type', registerForm);
  const loginPaymentType = Form.useWatch('payment_link_type', loginForm);

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

  const onSubmitRegister = async (values: RegisterForm) => {
    setSubmitting(true);
    try {
      const result = await triggerTask({
        mode: 'register',
        accounts: values.accounts,
        forwarding_emails: values.forwarding_emails,
        enable_mfa: values.enable_mfa,
        enable_711_proxy: isProxyEnabled(values.proxy_region),
        payment_link_type: values.payment_link_type,
        payment_card: values.payment_card,
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

  const onSubmitLogin = async (values: LoginForm) => {
    setSubmitting(true);
    try {
      const result = await triggerTask({
        mode: 'login',
        accounts: values.accounts,
        enable_711_proxy: isProxyEnabled(values.proxy_region),
        hold_minutes: Number(values.hold_minutes) || 5,
        payment_link_type: values.payment_link_type,
        payment_card: values.payment_card,
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

        {mode === 'register' ? (
          <Form
            form={registerForm}
            layout="vertical"
            className="task-form"
            initialValues={{
              forwarding_emails: FORWARDING_EMAIL_OPTIONS[0].value,
              enable_mfa: true,
              proxy_region: 'none',
              payment_link_type: '未选择',
              payment_card: '',
            }}
            onFinish={onSubmitRegister}
          >
            <Form.Item
              label="账号"
              name="accounts"
              rules={[{ required: true, message: '请填写账号' }]}
              extra="支持单邮箱、Outlook 四字段、iCloud 两字段；多账号用换行或分号分隔"
            >
              <TextArea rows={6} placeholder={'email@example.com\n或 email----password----client_id----refresh_token'} />
            </Form.Item>
            <Form.Item
              label="转发邮箱"
              name="forwarding_emails"
              extra="单邮箱账号时使用"
              rules={[{ required: true, message: '请选择转发邮箱' }]}
            >
              <Select options={FORWARDING_EMAIL_OPTIONS} />
            </Form.Item>
            <Space size="large" wrap className="switches">
              <Form.Item label="开启两步验证" name="enable_mfa" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item label="代理地区" name="proxy_region" rules={[{ required: true, message: '请选择代理地区' }]}>
                <Select style={{ width: 200 }} options={PROXY_REGION_OPTIONS} />
              </Form.Item>
              <Form.Item label="支付提链" name="payment_link_type">
                <Select style={{ width: 160 }} options={PAYMENT_LINK_OPTIONS} />
              </Form.Item>
            </Space>
            {registerPaymentType === 'gcash' ? (
              <Form.Item
                label="oai9 卡密"
                name="payment_card"
                rules={[{ required: true, message: '请填写卡密' }]}
                extra="汇总阶段提交到 long.oai9.com 提取 GCash 链接"
              >
                <Input.Password placeholder="卡密" autoComplete="off" />
              </Form.Item>
            ) : null}
            <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} loading={submitting} size="large">
              开始注册
            </Button>
          </Form>
        ) : (
          <Form
            form={loginForm}
            layout="vertical"
            className="task-form"
            initialValues={{
              proxy_region: 'none',
              hold_minutes: 5,
              payment_link_type: '未选择',
              payment_card: '',
            }}
            onFinish={onSubmitLogin}
          >
            <Form.Item
              label="账号"
              name="accounts"
              rules={[{ required: true, message: '请填写账号' }]}
              extra="格式：email----password----2fa（可带注册结果尾部字段）；多账号换行或分号分隔"
            >
              <TextArea rows={6} placeholder="email----password----2fa" />
            </Form.Item>
            <Space size="large" wrap className="switches">
              <Form.Item label="代理地区" name="proxy_region" rules={[{ required: true, message: '请选择代理地区' }]}>
                <Select style={{ width: 200 }} options={PROXY_REGION_OPTIONS} />
              </Form.Item>
              <Form.Item label="延迟关闭" name="hold_minutes" rules={[{ required: true, message: '请选择延迟关闭时间' }]}>
                <Select style={{ width: 140 }} options={HOLD_MINUTES_OPTIONS} />
              </Form.Item>
              <Form.Item label="支付提链" name="payment_link_type">
                <Select style={{ width: 160 }} options={PAYMENT_LINK_OPTIONS} />
              </Form.Item>
            </Space>
            {loginPaymentType === 'gcash' ? (
              <Form.Item
                label="oai9 卡密"
                name="payment_card"
                rules={[{ required: true, message: '请填写卡密' }]}
                extra="汇总阶段提交到 long.oai9.com 提取 GCash 链接"
              >
                <Input.Password placeholder="卡密" autoComplete="off" />
              </Form.Item>
            ) : null}
            <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} loading={submitting} size="large">
              开始登录
            </Button>
          </Form>
        )}
      </Card>

      {taskId && (
        <Card className="panel status-panel" bordered={false} title="处理进度">
          <Paragraph className="status-message">{status?.message || '已提交，等待开始处理'}</Paragraph>
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
                      {account.ok === true ? '完成' : account.ok === false ? account.error || '失败' : '处理中'}
                    </Text>
                  </div>
                  {account.accessToken ? (
                    <Space.Compact className="token-box">
                      <Input value={account.accessToken} readOnly />
                      <Button icon={<CopyOutlined />} onClick={() => void copyText(account.accessToken!)}>
                        复制
                      </Button>
                    </Space.Compact>
                  ) : null}
                  <AccountHoldCountdown holdUntil={account.holdUntil} />
                </div>
              ))}
            </div>
          ) : (
            <Alert type="info" showIcon message="等待账号进度更新…" style={{ marginTop: 16 }} />
          )}

          {status?.paymentLinks?.length ? (
            <div className="payment-links">
              <div className="payment-links-head">
                <Text strong>支付链接</Text>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => void copyText(status.paymentLinks!.join('\n'), '已复制全部链接')}
                >
                  复制全部
                </Button>
              </div>
              {status.paymentMessage ? <Paragraph type="secondary">{status.paymentMessage}</Paragraph> : null}
              <div className="payment-link-list">
                {status.paymentLinks.map((link) => (
                  <Space.Compact className="token-box" key={link}>
                    <Input value={link} readOnly />
                    <Button icon={<CopyOutlined />} onClick={() => void copyText(link)}>
                      复制
                    </Button>
                  </Space.Compact>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
