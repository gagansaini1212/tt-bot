"use client";

import { Fragment, useState, useTransition } from "react";
import Decimal from "decimal.js";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { instrumentLabel } from "@crypto-trading/domain";
import type { ExchangeOrder, AccountSnapshot } from "@crypto-trading/exchanges";
import type {
  ExecutionState,
  StopTrigger,
} from "@crypto-trading/exchanges/execution";
import {
  cancelImpact,
  type ManualOrderOutcome,
} from "@crypto-trading/exchanges/manual-order";

import { cancelOpenOrder, cancelStopLimit } from "@/app/order-actions";
import { OutcomeAlert } from "@/components/order-ticket";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  alertHeadline,
  isUrgent,
  triggerSummary,
} from "@/lib/execution-display";
import {
  baseAsset,
  groupOpenOrders,
  orderListSummary,
  orderPriceLabel,
  orderQuantityLabel,
  orderRole,
  orderStatusLabel,
  orderTypeLabel,
} from "@/lib/order-display";

type Snapshot = Pick<AccountSnapshot, "orders" | "pendingOrders">;

export function OpenOrders({
  snapshot,
  execution,
}: {
  snapshot: Snapshot;
  // What the worker's execution loop holds or is selling, when it reports.
  execution?: Pick<ExecutionState, "alerts" | "triggers">;
}) {
  const groups = groupOpenOrders(snapshot);
  const all = groups.flatMap((group) => group.orders);
  const alerts = execution?.alerts ?? [];
  const triggers = execution?.triggers ?? [];
  const [target, setTarget] = useState<ExchangeOrder>();
  const [trigger, setTrigger] = useState<StopTrigger>();
  const [outcome, setOutcome] = useState<ManualOrderOutcome>();
  return (
    <>
      {outcome ? (
        <div className="mb-4">
          <OutcomeAlert outcome={outcome} />
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Filled / quantity</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {alerts.map((alert) => (
            <TableRow
              className="bg-destructive/5 hover:bg-destructive/5"
              key={`alert-${alert.listClientOrderId}`}
            >
              <TableCell className="whitespace-normal text-xs" colSpan={5}>
                <div className="sticky left-3 max-w-[calc(100vw-6rem)] md:max-w-[calc(100vw-22rem)] xl:max-w-none">
                  <span
                    className={
                      isUrgent(alert)
                        ? "flex items-start gap-1.5 font-medium text-destructive"
                        : "flex items-start gap-1.5 font-medium"
                    }
                  >
                    <AlertTriangle
                      aria-hidden
                      className="mt-px size-3.5 shrink-0"
                    />
                    {alertHeadline(alert)} · order {alert.listClientOrderId}
                  </span>
                  <span className="mt-1 block text-foreground">
                    {alert.detail}
                  </span>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {triggers.map((held) => (
            <TableRow key={`trigger-${held.listClientOrderId}`}>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  <Badge variant="outline">Entry</Badge>
                  <span className="font-medium">
                    {instrumentLabel(held.instrument)}
                  </span>
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Stop limit buy
                </span>
              </TableCell>
              <TableCell className="font-mono text-xs">
                0 / {plain(held.quantity)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {plain(held.price)} · stop {plain(held.stopPrice)}
              </TableCell>
              <TableCell>
                Held by the worker
                <span className="mt-1 block text-xs text-muted-foreground">
                  TP {plain(held.takeProfitPrice)} · SL{" "}
                  {plain(held.stopLossPrice)}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  aria-label={`Cancel stop-limit buy ${held.instrument.split("-")[0]}, stop ${plain(held.stopPrice)}`}
                  onClick={() => setTrigger(held)}
                  size="sm"
                  variant="destructive"
                >
                  Cancel
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {groups.map((group) => (
            <Fragment key={group.key}>
              {group.orderListId !== undefined ? (
                <ListHeader
                  orderListId={group.orderListId}
                  orders={group.orders}
                />
              ) : null}
              {group.orders.map((order) => (
                <TableRow key={`${order.instrument}-${order.orderId}`}>
                  <TableCell
                    className={
                      group.orderListId !== undefined
                        ? "border-l-2 border-l-border pl-3"
                        : undefined
                    }
                  >
                    <span className="flex items-center gap-1.5">
                      {orderRole(order) ? (
                        <Badge variant="outline">{orderRole(order)}</Badge>
                      ) : null}
                      <span className="font-medium">
                        {instrumentLabel(order.instrument)}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {orderTypeLabel(order)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {orderQuantityLabel(order)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {orderPriceLabel(order)}
                  </TableCell>
                  <TableCell>{orderStatusLabel(order)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      aria-label={`Cancel ${describe(order)}`}
                      onClick={() => setTarget(order)}
                      size="sm"
                      variant="destructive"
                    >
                      Cancel
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
          {groups.length + triggers.length + alerts.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5}>No open orders.</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {target ? (
        <CancelDialog
          key={`${target.instrument}-${target.orderId}`}
          onClose={() => setTarget(undefined)}
          onDone={(result) => {
            setOutcome(result);
            setTarget(undefined);
          }}
          orders={all}
          target={target}
        />
      ) : null}
      {trigger ? (
        <TriggerCancelDialog
          key={trigger.listClientOrderId}
          onClose={() => setTrigger(undefined)}
          onDone={(result) => {
            setOutcome(result);
            setTrigger(undefined);
          }}
          trigger={trigger}
        />
      ) : null}
    </>
  );
}

function TriggerCancelDialog({
  trigger,
  onClose,
  onDone,
}: {
  trigger: StopTrigger;
  onClose: () => void;
  onDone: (outcome: ManualOrderOutcome) => void;
}) {
  const [pending, startTransition] = useTransition();
  const confirm = () =>
    startTransition(async () => {
      onDone(await cancelStopLimit(trigger.listClientOrderId));
    });
  return (
    <AlertDialog onOpenChange={(open) => !open && !pending && onClose()} open>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this stop-limit buy?</AlertDialogTitle>
          <AlertDialogDescription>
            {triggerSummary(trigger)}. The worker holds it, so nothing is on
            Binance yet. If its stop price trades first, it is sent before the
            cancel arrives: then cancel it from this table.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep order</AlertDialogCancel>
          <Button
            className="dark:bg-destructive/10"
            disabled={pending}
            onClick={confirm}
            variant="destructive"
          >
            {pending ? <LoaderCircle className="animate-spin" /> : null}
            Cancel stop-limit buy
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ListHeader({
  orderListId,
  orders,
}: {
  orderListId: string;
  orders: ExchangeOrder[];
}) {
  const summary = orderListSummary(orders);
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell className="whitespace-normal text-xs" colSpan={5}>
        {/* Stays in view while a narrow screen scrolls the table sideways. */}
        <div className="sticky left-3 max-w-[calc(100vw-6rem)] md:max-w-[calc(100vw-22rem)] xl:max-w-none">
          <span className="font-medium">Order list {orderListId}</span>{" "}
          {summary.warning ? (
            <span className="mt-1 flex items-start gap-1.5 font-medium text-destructive">
              <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
              {summary.text}
            </span>
          ) : (
            <span className="text-muted-foreground">· {summary.text}</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CancelDialog({
  target,
  orders,
  onClose,
  onDone,
}: {
  target: ExchangeOrder;
  orders: ExchangeOrder[];
  onClose: () => void;
  onDone: (outcome: ManualOrderOutcome) => void;
}) {
  const impact = cancelImpact(target, orders);
  const [pending, startTransition] = useTransition();
  // The worker may find more filled than this snapshot showed.
  const [unprotected, setUnprotected] = useState(impact.unprotectedQuantity);
  const [message, setMessage] = useState<string>();
  const exposed = new Decimal(unprotected).greaterThan(0);
  const list = target.orderListId !== null;
  const asset = baseAsset(target.instrument);
  const { instrument } = target;

  const confirm = () =>
    startTransition(async () => {
      const outcome = await cancelOpenOrder({
        instrument,
        orderId: target.orderId,
        acceptUnprotected: exposed,
      });
      if (outcome.status === "confirmation_required") {
        setUnprotected(outcome.unprotectedQuantity ?? unprotected);
        setMessage(outcome.message);
        return;
      }
      onDone(outcome);
    });

  return (
    <AlertDialog onOpenChange={(open) => !open && !pending && onClose()} open>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {list ? "Cancel the whole order list?" : "Cancel this order?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {list
              ? "Binance cancels every order in a list together, so this cancels:"
              : "This cancels:"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1 text-sm">
          {impact.cancels.map((order) => (
            <li key={order.orderId}>
              <span className="font-medium">
                {orderRole(order) ?? orderTypeLabel(order)}
              </span>{" "}
              <span className="text-muted-foreground">
                {describe(order)} · {orderStatusLabel(order).toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
        {exposed ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>
              {unprotected} {asset} will have no exits
            </AlertTitle>
            <AlertDescription>
              {message ??
                `The entry has already bought ${unprotected} ${asset}. After this cancel it has no take profit or stop loss on Binance.`}
            </AlertDescription>
          </Alert>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Cancelling does not reverse fills that have already happened.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep order</AlertDialogCancel>
          <Button
            // A lighter tint keeps the red label readable on the muted footer.
            className="dark:bg-destructive/10"
            disabled={pending}
            onClick={confirm}
            variant="destructive"
          >
            {pending ? <LoaderCircle className="animate-spin" /> : null}
            {exposed
              ? `Cancel and leave ${unprotected} ${asset} unprotected`
              : list
                ? `Cancel ${impact.cancels.length} orders`
                : "Cancel order"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Like Binance's own rows: exact, without separators.
function plain(value: string) {
  return new Decimal(value).toFixed();
}

function describe(order: ExchangeOrder) {
  return `${orderTypeLabel(order)} ${baseAsset(order.instrument)}, ${orderPriceLabel(order)}`;
}
