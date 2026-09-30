import { describe, expect, it } from "vitest";
import manifest from "../package.json";

const hostProvidedPackages = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@sinclair/typebox",
];

describe("extension package manifest", () => {
    it.each(hostProvidedPackages)("declares %s as a host-provided peer", (packageName) => {
        expect(manifest).toHaveProperty(["peerDependencies", packageName], "*");
        expect(manifest).not.toHaveProperty(["dependencies", packageName]);
        expect(manifest).toHaveProperty(["devDependencies", packageName]);
    });
});
