export enum MercadoPagoNotificationType {
  Payment = 'payment'
}

export enum MercadoPagoPaymentStatus {
  Approved = 'approved',
  Pending = 'pending',
  InProcess = 'in_process',
  Rejected = 'rejected',
  Cancelled = 'cancelled'
}

export type MercadoPagoPaymentStatusId = `${MercadoPagoPaymentStatus}`;

const PENDING_PAYMENT_STATUS_SET = new Set<MercadoPagoPaymentStatusId>([
  MercadoPagoPaymentStatus.Pending,
  MercadoPagoPaymentStatus.InProcess
]);

const CANCELLED_PAYMENT_STATUS_SET = new Set<MercadoPagoPaymentStatusId>([
  MercadoPagoPaymentStatus.Rejected,
  MercadoPagoPaymentStatus.Cancelled
]);

export const isPendingMercadoPagoPaymentStatus = (
  status: string | null | undefined
): status is `${MercadoPagoPaymentStatus.Pending}` | `${MercadoPagoPaymentStatus.InProcess}` =>
  typeof status === 'string' && PENDING_PAYMENT_STATUS_SET.has(status as MercadoPagoPaymentStatusId);

export const isCancelledMercadoPagoPaymentStatus = (
  status: string | null | undefined
): status is `${MercadoPagoPaymentStatus.Rejected}` | `${MercadoPagoPaymentStatus.Cancelled}` =>
  typeof status === 'string' && CANCELLED_PAYMENT_STATUS_SET.has(status as MercadoPagoPaymentStatusId);

export enum PaymentRedirectStatus {
  Success = 'success',
  Pending = 'pending',
  Failure = 'failure'
}

export enum MercadoPagoAutoReturn {
  Approved = 'approved'
}
