import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, adminDb
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function startSubscriptionCheckout(call: AgentToolCall, ctx: AgentExecutionContext) {
  const plan = String(call.args.plan || '').trim();
  if (!plan) throw new Error('plan es requerido');
  // El checkout real lo dispara el cliente desde /pricing porque MercadoPago
  // SDK init/Browser Bricks deben ejecutarse en el navegador. Devolvemos un
  // uiCommand que abre el panel pricing y deja el plan preseleccionado.
  const userSnap = await adminDb.collection('users').doc(ctx.uid).get();
  const data = userSnap.data() as Record<string, unknown> | undefined;
  const currentPlan = typeof data?.plan === 'string' ? data.plan : 'free';
  return ok(call, `Plan actual: ${currentPlan}. Para iniciar checkout de "${plan}" abro el panel de pricing — el SDK de MercadoPago corre en el navegador.`, {
    plan,
    currentPlan,
    uiCommand: {
      type: 'open_panel',
      panel: 'settings',
      section: 'pricing',
      planHint: plan
    },
    notImplementedFully: true,
    suggestion: 'el cliente abre el panel pricing y completa el flow MercadoPago Brick allí'
  });
}

export const SUBSCRIPTION_TOOL_HANDLERS: Record<string, ToolHandler> = {
  start_subscription_checkout: startSubscriptionCheckout
};
