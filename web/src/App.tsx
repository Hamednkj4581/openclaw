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

interface RegisterForm {
  accounts: string;
  forwarding_emails: string;
  enable_mfa: boolean;
  proxy_region: string;
  payment_link_type: string;
}

interface LoginForm {
  accounts: string;
  proxy_region: string;
}

function isProxyEnabled(region: string | undefined): boolean {
  return Boolean(region && region !== 'none');
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

  const copyToken = async (token: string) => {
    await navigator.clipboard.writeText(token);
    message.success('已复制');
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
                <Select
                  style={{ width: 160 }}
                  options={[
                    { value: '未选择', label: '未选择' },
                    { value: 'gcash', label: 'gcash' },
                  ]}
                />
              </Form.Item>
            </Space>
            <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} loading={submitting} size="large">
              开始注册
            </Button>
          </Form>
        ) : (
          <Form
            form={loginForm}
            layout="vertical"
            className="task-form"
            initialValues={{ proxy_region: 'none' }}
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
            <Form.Item label="代理地区" name="proxy_region" rules={[{ required: true, message: '请选择代理地区' }]}>
              <Select style={{ width: 200 }} options={PROXY_REGION_OPTIONS} />
            </Form.Item>
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
                      <Button icon={<CopyOutlined />} onClick={() => void copyToken(account.accessToken!)}>
                        复制
                      </Button>
                    </Space.Compact>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <Alert type="info" showIcon message="等待账号进度更新…" style={{ marginTop: 16 }} />
          )}
        </Card>
      )}
    </div>
  );
}
