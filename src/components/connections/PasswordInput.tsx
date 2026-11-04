import { useState, type InputHTMLAttributes } from "react";
import { useT } from "../../i18n";

export default function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  const t = useT();
  return <span className="password-field">
    <input {...props} type={visible ? "text" : "password"} />
    <button type="button" aria-label={t(visible ? "common.hidePassword" : "common.showPassword")}
      aria-pressed={visible} onClick={() => setVisible(!visible)}>
      {t(visible ? "common.hidePassword" : "common.showPassword")}
    </button>
  </span>;
}
