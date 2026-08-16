// 從 C:\morph-particles\src\Experience\Utils\FBO.js 移植過來的通用 GPGPU
// ping-pong 工具：把「粒子位置」的計算丟給 GPU 用一張 RGBA float 貼圖存放，
// simulationMaterial 每幀更新這張貼圖（模擬），renderMaterial 再讀這張貼圖
// 決定每個點畫在哪（渲染）。跟原檔幾乎一字不動——這段本來就跟「卷動網站」
// 無關，是通用的 FBO 機制，desktop-pet 這邊直接沿用。
import * as THREE from 'three';

export default class FBO {
  constructor(width, height, renderer, simulationMaterial, renderMaterial) {
    this.width = width;
    this.height = height;
    this.renderer = renderer;
    this.simulationMaterial = simulationMaterial;
    this.renderMaterial = renderMaterial;

    this.gl = this.renderer.getContext();

    this.init();
  }

  init() {
    this.createTarget();
    this.simSetup();
    this.createParticles();
  }

  createTarget() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1 / Math.pow(2, 53), 1);

    this.rtt = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });
  }

  simSetup() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          -1, -1, 0,
          1, -1, 0,
          1, 1, 0,

          -1, -1, 0,
          1, 1, 0,
          -1, 1, 0,
        ]),
        3
      )
    );

    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(
        new Float32Array([
          0, 1,
          1, 1,
          1, 0,

          0, 1,
          1, 0,
          0, 0,
        ]),
        2
      )
    );

    this.mesh = new THREE.Mesh(geometry, this.simulationMaterial);
    this.scene.add(this.mesh);
  }

  createParticles() {
    const length = this.width * this.height;
    const vertices = new Float32Array(length * 3);
    for (let i = 0; i < length; i++) {
      const i3 = i * 3;
      vertices[i3 + 0] = (i % this.width) / this.width;
      vertices[i3 + 1] = (i / this.width) / this.height;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    this.particles = new THREE.Points(geometry, this.renderMaterial);
  }

  resize() {
    this.rtt.setSize(this.width, this.height);
  }

  update() {
    this.renderer.setRenderTarget(this.rtt);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    this.particles.material.uniforms.uPositions.value = this.rtt.texture;
  }

  dispose() {
    this.rtt.dispose();
    this.mesh.geometry.dispose();
    this.particles.geometry.dispose();
  }
}
