// synapse-ocr: local text recognition with Apple Vision. Receives image bytes
// only, so it needs no TCC permission.
//
//   synapse-ocr                        server: NDJSON requests on stdin, one JSON line per reply on stdout
//   synapse-ocr --probe                prints {"ok":true,"version":...}
//   synapse-ocr --self-test            renders known text, recognises it, exits 0 if all expected strings match
//   synapse-ocr --render <out.png> <text-file>   renders the file's lines to a PNG (2x, dark monospace on white)
//
// Request:  {"id","image":base64,"level":"accurate"|"fast","languages":[..],"languageCorrection":bool}
// Reply:    {"id","ok":true,"width","height","ms","lines":[{"text","confidence","box":{x,y,w,h}}]}
//           {"id","ok":false,"error":{"code":"OCR_FAILED"|"BAD_REQUEST","message"}}
// Boxes are normalized 0..1 with a top-left origin; lines run top to bottom, then left to right.

import AppKit
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let version = "1.0.0"
let revision = 1

struct OcrLine {
    let text: String
    let confidence: Float
    let x: Double, y: Double, w: Double, h: Double
}

struct OcrFailure: Error {
    let code: String
    let message: String
}

func writeLine(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    var out = data
    out.append(0x0A)
    FileHandle.standardOutput.write(out)
}

func decodeImage(_ data: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          CGImageSourceGetCount(source) > 0,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw OcrFailure(code: "BAD_REQUEST", message: "image bytes are not a decodable JPEG/PNG") }
    return image
}

/// Lines whose vertical centres sit within half a line height share a row and
/// are ordered left to right; rows are ordered top to bottom.
func readingOrder(_ lines: [OcrLine]) -> [OcrLine] {
    let byTop = lines.sorted { ($0.y + $0.h / 2) < ($1.y + $1.h / 2) }
    var rows: [[OcrLine]] = []
    var rowMid = 0.0
    var rowHeight = 0.0
    for line in byTop {
        let mid = line.y + line.h / 2
        if !rows.isEmpty && abs(mid - rowMid) <= rowHeight * 0.5 {
            rows[rows.count - 1].append(line)
        } else {
            rows.append([line])
            rowMid = mid
            rowHeight = line.h
        }
    }
    return rows.flatMap { $0.sorted { $0.x < $1.x } }
}

func recognize(_ image: CGImage, level: String, languages: [String], correction: Bool) throws -> [OcrLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level == "fast" ? .fast : .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = correction
    request.automaticallyDetectsLanguage = false
    // Dense code screenshots have small glyphs; the default (1/32 of image
    // height) would skip them.
    request.minimumTextHeight = 0.004

    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        throw OcrFailure(code: "OCR_FAILED", message: "Vision request failed: \(error.localizedDescription)")
    }

    let lines: [OcrLine] = (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox  // bottom-left origin
        return OcrLine(
            text: candidate.string, confidence: candidate.confidence,
            x: Double(box.origin.x), y: 1 - Double(box.origin.y + box.size.height),
            w: Double(box.size.width), h: Double(box.size.height))
    }
    return readingOrder(lines)
}

// MARK: - Rendering (self-test and --render)

func renderText(_ lines: [String], scale: CGFloat = 2) -> CGImage? {
    let fontSize: CGFloat = 14 * scale
    let font = CTFontCreateWithName("Menlo" as CFString, fontSize, nil)
    let lineHeight = fontSize * 1.5
    let margin = 20 * scale
    var glyph = CTFontGetGlyphWithName(font, "M" as CFString)
    var advance = CGSize.zero
    CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
    let longest = lines.map { $0.count }.max() ?? 1
    let width = Int(margin * 2 + CGFloat(max(longest, 20)) * advance.width)
    let height = Int(margin * 2 + lineHeight * CGFloat(max(lines.count, 1)))

    guard let ctx = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }

    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let ink = CGColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1)
    for (index, text) in lines.enumerated() {
        let attributed = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
        ])
        let line = CTLineCreateWithAttributedString(attributed)
        ctx.textPosition = CGPoint(x: margin, y: CGFloat(height) - margin - lineHeight * CGFloat(index + 1) + fontSize * 0.4)
        CTLineDraw(line, ctx)
    }
    return ctx.makeImage()
}

func writePng(_ image: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

func normalizeWhitespace(_ s: String) -> String {
    s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func runSelfTest() -> Never {
    let source = [
        "Campus FAQ Bot",
        "def answer(question):",
        "    if question == 'hours':",
        "        return 'Library opens at 9'",
        "    return None",
        "Expected Output: 42",
    ]
    let expected = ["Campus FAQ Bot", "def answer(question):", "Expected Output: 42"]
    guard let image = renderText(source) else { fail("self-test: render failed") }
    do {
        let lines = try recognize(image, level: "accurate", languages: ["en-US"], correction: false)
        let haystack = normalizeWhitespace(lines.map { $0.text }.joined(separator: " "))
        let missing = expected.filter { !haystack.contains(normalizeWhitespace($0)) }
        writeLine(["ok": missing.isEmpty, "lines": lines.map { $0.text }, "expected": expected, "missing": missing])
        exit(missing.isEmpty ? 0 : 1)
    } catch let failure as OcrFailure {
        writeLine(["ok": false, "error": ["code": failure.code, "message": failure.message]])
        exit(1)
    } catch {
        fail("self-test: \(error)")
    }
}

// MARK: - Server

func handle(_ raw: String) {
    guard let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        writeLine(["id": NSNull(), "ok": false, "error": ["code": "BAD_REQUEST", "message": "request is not a JSON object"]])
        return
    }
    let id = object["id"] as? String ?? ""
    func reply(_ code: String, _ message: String) {
        writeLine(["id": id, "ok": false, "error": ["code": code, "message": message]])
    }
    guard !id.isEmpty else { return reply("BAD_REQUEST", "missing id") }
    guard let b64 = object["image"] as? String, let bytes = Data(base64Encoded: b64) else {
        return reply("BAD_REQUEST", "image must be base64")
    }
    let level = object["level"] as? String ?? "accurate"
    guard level == "accurate" || level == "fast" else { return reply("BAD_REQUEST", "level must be accurate or fast") }
    let languages = (object["languages"] as? [String]).flatMap { $0.isEmpty ? nil : $0 } ?? ["en-US"]
    let correction = object["languageCorrection"] as? Bool ?? false

    let started = DispatchTime.now()
    do {
        let image = try decodeImage(bytes)
        let lines = try recognize(image, level: level, languages: languages, correction: correction)
        let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
        writeLine([
            "id": id, "ok": true, "width": image.width, "height": image.height, "ms": Int(ms.rounded()),
            "lines": lines.map { [
                "text": $0.text, "confidence": Double($0.confidence),
                "box": ["x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h],
            ] as [String: Any] },
        ])
    } catch let failure as OcrFailure {
        reply(failure.code, failure.message)
    } catch {
        reply("OCR_FAILED", "\(error)")
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--probe" {
    writeLine(["ok": true, "version": version])
    exit(0)
} else if args.first == "--self-test" {
    runSelfTest()
} else if args.first == "--render" {
    guard args.count == 3 else { fail("usage: --render <out.png> <text-file>") }
    guard let text = try? String(contentsOfFile: args[2], encoding: .utf8) else { fail("cannot read \(args[2])") }
    var rows = text.components(separatedBy: "\n")
    if rows.last == "" { rows.removeLast() }
    guard let image = renderText(rows), writePng(image, to: args[1]) else { fail("render failed") }
    exit(0)
} else if !args.isEmpty {
    fail("unknown argument \(args[0])")
}

writeLine(["event": "ready", "version": version, "revision": revision])
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    autoreleasepool { handle(line) }
}
exit(0)
