package main

import (
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
)

func main() {
	const size = 512
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	bg := color.RGBA{R: 124, G: 106, B: 247, A: 255}
	draw.Draw(img, img.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)

	// Draw a rounded white checkmark
	cx, cy := float64(size)/2, float64(size)/2
	r := float64(size) * 0.28
	thick := float64(size) * 0.07

	// Two line segments of a checkmark: left-down, then right-up
	p1 := [2]float64{cx - r*0.6, cy}
	p2 := [2]float64{cx - r*0.1, cy + r*0.55}
	p3 := [2]float64{cx + r*0.7, cy - r*0.55}

	drawThickLine(img, p1, p2, thick, color.White)
	drawThickLine(img, p2, p3, thick, color.White)

	f, _ := os.Create("source.png")
	defer f.Close()
	png.Encode(f, img)
}

func drawThickLine(img *image.RGBA, a, b [2]float64, thick float64, c color.Color) {
	bounds := img.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			d := distToSegment(float64(x), float64(y), a[0], a[1], b[0], b[1])
			if d < thick/2 {
				img.Set(x, y, c)
			}
		}
	}
}

func distToSegment(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	if dx == 0 && dy == 0 {
		return math.Hypot(px-ax, py-ay)
	}
	t := ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)
	t = math.Max(0, math.Min(1, t))
	return math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
}
