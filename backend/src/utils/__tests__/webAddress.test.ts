import { isWebAddress } from "../webAddress";

describe("isWebAddress", () => {
    it.each([
        "https://pictures.example/a.jpg",
        "http://pictures.example",
        "HTTPS://pictures.example/a.jpg",
        "http://localhost:3030/x",
    ])("accepts %s", (address) => {
        expect(isWebAddress(address)).toBe(true);
    });

    it.each([
        "",
        "native:covers/a.jpg",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "//pictures.example/a.jpg",
        "pictures.example/a.jpg",
        "/covers/a.jpg",
        "https://",
        "https:///a.jpg",
        "https:// pictures.example",
        " https://pictures.example/a.jpg",
    ])("refuses %j", (address) => {
        expect(isWebAddress(address)).toBe(false);
    });
});
