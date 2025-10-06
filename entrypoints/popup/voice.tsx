import { createRoot } from "react-dom/client";
import PhoneMicPopup from "../../src/components/popups/PhoneMicPopup";
import "../../src/components/cmdk-palette/styles.css";

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("root");
  if (container) {
    const root = createRoot(container);
    root.render(<PhoneMicPopup />);
  }
});
