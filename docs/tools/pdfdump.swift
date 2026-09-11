import Foundation
import PDFKit
import AppKit

// Usage: swift pdfdump.swift <input.pdf> <outdir> <scale>
let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: pdfdump <pdf> <outdir> [scale]"); exit(1) }
let url = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
let scale = args.count > 3 ? CGFloat(Double(args[3]) ?? 1.0) : 1.0
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

guard let doc = PDFDocument(url: url) else { print("cannot open"); exit(1) }
var allText = ""
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    allText += "\n\n===== PAGE \(i + 1) (\(Int(bounds.width))x\(Int(bounds.height))) =====\n"
    allText += page.string ?? "(no text)"

    // Render PNG
    let w = Int(bounds.width * scale), h = Int(bounds.height * scale)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext
    cg.setFillColor(NSColor.white.cgColor)
    cg.fill(CGRect(x: 0, y: 0, width: w, height: h))
    cg.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: cg)
    NSGraphicsContext.restoreGraphicsState()
    if let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: outDir.appendingPathComponent(String(format: "page-%02d.png", i + 1)))
    }
}
try? allText.write(to: outDir.appendingPathComponent("text.txt"), atomically: true, encoding: .utf8)
print("pages: \(doc.pageCount)")
