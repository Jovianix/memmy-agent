import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "../../components/button.js";
import { Modal } from "../../components/modal.js";
import { useTranslation } from "../../i18n/use-translation.js";

export function ComputerHistoryRecordingConfirmation(props: {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
  onAllowAll?: () => void;
  windows?: boolean;
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [noticeBefore, noticeAfter] = t("computerHistory.enableModelNotice").split("{operations}");

  useLayoutEffect(() => {
    if (!props.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [props.open]);

  if (!props.open) return null;

  return createPortal(
    <div className="ch-recording-confirmation">
      <Modal
        open
        title={t("computerHistory.enableTitle")}
        className="confirm-dialog confirm-dialog--titled"
        bodyClassName="confirm-dialog__body"
        footerClassName="confirm-dialog__footer"
        style={{ width: props.onAllowAll ? 560 : 440, maxWidth: "calc(100vw - 32px)" }}
        initialFocusRef={cancelRef}
        ariaDescribedBy={descriptionId}
        closeLabel={t("common.close")}
        closeContent={<X size={16} aria-hidden="true" />}
        onClose={props.onCancel}
        footer={<>
          <Button ref={cancelRef} type="button" variant="ghost" size="sm" onClick={props.onCancel}>{t("dialog.cancel")}</Button>
          {props.onAllowAll && <Button type="button" variant="soft" size="sm" onClick={props.onAllowAll}>
            {t("computerHistory.allowAllApps")}
          </Button>}
          <Button type="button" variant="primary" size="sm" onClick={props.onConfirm}>
            {t(props.onAllowAll ? "computerHistory.customizeApps" : "computerHistory.enableConfirm")}
          </Button>
        </>}
      >
        <ul id={descriptionId} className="ch-recording-confirmation__details">
          <li>
            {noticeBefore}
            <strong className="font-semibold text-text-ink">{t(props.windows ? "computerHistory.windows.selectedOperations" : "computerHistory.enableAllOperations")}</strong>
            {noticeAfter}{t("computerHistory.enableLocalNotice")}
          </li>
          {props.windows && <li>{t("computerHistory.windows.stopHotkey")}</li>}
          {props.onAllowAll && <li>{t("computerHistory.enableScopeNotice")}</li>}
        </ul>
      </Modal>
    </div>,
    document.body
  );
}
