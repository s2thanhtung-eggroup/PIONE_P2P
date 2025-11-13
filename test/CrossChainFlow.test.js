const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Cross-Chain P2P Trading Flow", function () {
  let pioneEscrow, bscEscrow;
  let mockOracle, mockUSDT, mockPIO, mockPair;
  let owner, pioneSeller, pioneSellerOnBSC, bscSeller, bscSellerOnPione, buyer, bridgeAdmin, feeRecipient;

  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const BRIDGE_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ADMIN_ROLE"));

  // Constants
  const ORACLE_PRICE = ethers.parseUnits("0.5", 18); // 0.5 USD per PIO
  const USDT_DECIMALS = 18;

  // Pione Chain constants
  const PIO_AMOUNT = ethers.parseEther("1000"); // 1000 PIO
  const PIO_MIN_PER_TRADE = ethers.parseEther("100");
  const PIO_MAX_PER_TRADE = ethers.parseEther("500");
  const PRICE_PER_PIO = ethers.parseUnits("0.5", 18);

  // BSC Chain constants
  const USDT_AMOUNT = ethers.parseUnits("1000", USDT_DECIMALS); // 1000 USDT
  const USDT_MIN_PER_TRADE = ethers.parseUnits("100", USDT_DECIMALS);
  const USDT_MAX_PER_TRADE = ethers.parseUnits("500", USDT_DECIMALS);

  // Pancake reserves
  const PIO_RESERVE = ethers.parseEther("1000000");
  const USDT_RESERVE = ethers.parseUnits("500000", USDT_DECIMALS);

  beforeEach(async function () {
    [owner, pioneSeller, pioneSellerOnBSC, bscSeller, bscSellerOnPione, buyer, bridgeAdmin, feeRecipient] = await ethers.getSigners();

    // ===== Deploy Pione Chain Contracts =====
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    mockOracle = await MockPriceOracle.deploy(ORACLE_PRICE);

    const PioneP2PEscrow = await ethers.getContractFactory("PioneP2PEscrow");
    pioneEscrow = await PioneP2PEscrow.deploy(
      await mockOracle.getAddress(),
      feeRecipient.address
    );
    await pioneEscrow.grantRole(BRIDGE_ADMIN_ROLE, bridgeAdmin.address);

    // ===== Deploy BSC Chain Contracts =====
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDT = await MockERC20.deploy("Mock USDT", "USDT");
    mockPIO = await MockERC20.deploy("Mock PIO", "PIO");

    const MockPancakePair = await ethers.getContractFactory("MockPancakePair");
    mockPair = await MockPancakePair.deploy(
      await mockPIO.getAddress(),
      await mockUSDT.getAddress()
    );
    await mockPair.setReserves(PIO_RESERVE, USDT_RESERVE);

    const BSCP2PEscrow = await ethers.getContractFactory("BSCP2PEscrow");
    bscEscrow = await BSCP2PEscrow.deploy(
      await mockUSDT.getAddress(),
      await mockPIO.getAddress(),
      await mockPair.getAddress(),
      feeRecipient.address
    );
    await bscEscrow.grantRole(BRIDGE_ADMIN_ROLE, bridgeAdmin.address);

    // Mint and approve USDT on BSC
    await mockUSDT.mint(bscSeller.address, USDT_AMOUNT * 10n);
    await mockUSDT.mint(buyer.address, USDT_AMOUNT * 10n);
    await mockUSDT.connect(bscSeller).approve(await bscEscrow.getAddress(), ethers.MaxUint256);
    await mockUSDT.connect(buyer).approve(await bscEscrow.getAddress(), ethers.MaxUint256);
  });

  describe("Scenario 1: Sell PIO (Pione → BSC)", function () {
    let pioneOrderId, bscTradeId;
    const TRADE_PIO_AMOUNT = ethers.parseEther("300"); // 300 PIO

    it("Should complete full flow: Create order on Pione → Create trade on BSC → Release PIO", async function () {
      // Step 1: Seller creates order on Pione Chain (locks PIO)
      const tx1 = await pioneEscrow.connect(pioneSeller).createOrder(
        PIO_MIN_PER_TRADE,
        PIO_MAX_PER_TRADE,
        PRICE_PER_PIO,
        { value: PIO_AMOUNT }
      );

      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      pioneOrderId = pioneEscrow.interface.parseLog(event1).args.orderId;

      console.log("✓ Pione: Order created with ID:", pioneOrderId);

      // Verify PIO is locked
      const contractBalancePione = await ethers.provider.getBalance(await pioneEscrow.getAddress());
      expect(contractBalancePione).to.equal(PIO_AMOUNT);

      // Step 2: Buyer pays USDT on BSC Chain (off-chain event detected by bridge)
      // Bridge admin creates trade on Pione to lock PIO for this specific trade
      bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_001"));

      const tx2 = await pioneEscrow.connect(bridgeAdmin).createTrade(
        bscTradeId,
        pioneOrderId,
        buyer.address,
        TRADE_PIO_AMOUNT
      );

      console.log("✓ Pione: Trade created with BSC trade ID:", bscTradeId);

      // Verify PIO is reserved for trade
      const order = await pioneEscrow.getOrder(pioneOrderId);
      expect(order.availablePIO).to.equal(PIO_AMOUNT - TRADE_PIO_AMOUNT);

      // Step 3: Bridge confirms USDT payment on BSC and releases PIO on Pione
      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
      const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient.address);

      await pioneEscrow.connect(bridgeAdmin).releasePIOForBuyer(bscTradeId);

      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
      const feeRecipientBalanceAfter = await ethers.provider.getBalance(feeRecipient.address);

      // Verify amounts
      const feePercent = await pioneEscrow.feePercent();
      const expectedFee = (TRADE_PIO_AMOUNT * feePercent) / 10000n;
      const expectedBuyerAmount = TRADE_PIO_AMOUNT - expectedFee;

      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(expectedBuyerAmount);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);

      console.log("✓ Pione: PIO released to buyer");
      console.log("  - Buyer received:", ethers.formatEther(expectedBuyerAmount), "PIO");
      console.log("  - Fee collected:", ethers.formatEther(expectedFee), "PIO");

      // Verify trade is completed
      const trade = await pioneEscrow.getSellPIOTrade(bscTradeId);
      expect(trade.status).to.equal(2); // TradeStatus.Paid
    });

    it("Should handle trade cancellation properly", async function () {
      // Create order
      const tx1 = await pioneEscrow.connect(pioneSeller).createOrder(
        PIO_MIN_PER_TRADE,
        PIO_MAX_PER_TRADE,
        PRICE_PER_PIO,
        { value: PIO_AMOUNT }
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      pioneOrderId = pioneEscrow.interface.parseLog(event1).args.orderId;

      // Create trade
      bscTradeId = ethers.keccak256(ethers.toUtf8Bytes("bsc_trade_002"));
      await pioneEscrow.connect(bridgeAdmin).createTrade(
        bscTradeId,
        pioneOrderId,
        buyer.address,
        TRADE_PIO_AMOUNT
      );

      // Cancel trade (buyer didn't pay on BSC)
      await pioneEscrow.connect(bridgeAdmin).cancelTrade(bscTradeId);

      console.log("✓ Pione: Trade cancelled");

      // Verify PIO is unlocked back to order
      const order = await pioneEscrow.getOrder(pioneOrderId);
      expect(order.availablePIO).to.equal(PIO_AMOUNT);

      const trade = await pioneEscrow.getSellPIOTrade(bscTradeId);
      expect(trade.status).to.equal(4); // TradeStatus.Cancelled
    });
  });

  describe("Scenario 2: Sell USDT (BSC → Pione)", function () {
    let bscOrderId, pioneTradeId;
    const TRADE_USDT_AMOUNT = ethers.parseUnits("300", USDT_DECIMALS); // 300 USDT

    it("Should complete full flow: Create order on BSC → Create trade on Pione → Release USDT", async function () {
      // Step 1: Seller creates order on BSC Chain (locks USDT)
      const tx1 = await bscEscrow.connect(bscSeller).createOrder(
        USDT_AMOUNT,
        USDT_MIN_PER_TRADE,
        USDT_MAX_PER_TRADE,
        PRICE_PER_PIO
      );

      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return bscEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      bscOrderId = bscEscrow.interface.parseLog(event1).args.orderId;

      console.log("✓ BSC: Order created with ID:", bscOrderId);

      // Verify USDT is locked
      const contractBalanceBSC = await mockUSDT.balanceOf(await bscEscrow.getAddress());
      expect(contractBalanceBSC).to.equal(USDT_AMOUNT);

      // Step 2: Buyer pays PIO on Pione Chain (off-chain event detected by bridge)
      // Bridge admin creates trade on BSC to lock USDT for this specific trade
      pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_001"));

      const tx2 = await bscEscrow.connect(bridgeAdmin).createTrade(
        pioneTradeId,
        bscOrderId,
        buyer.address,
        TRADE_USDT_AMOUNT
      );

      console.log("✓ BSC: Trade created with Pione trade ID:", pioneTradeId);

      // Verify USDT is reserved for trade
      const order = await bscEscrow.getOrder(bscOrderId);
      expect(order.availableUSDT).to.equal(USDT_AMOUNT - TRADE_USDT_AMOUNT);

      // Step 3: Bridge confirms PIO payment on Pione and releases USDT on BSC
      const buyerBalanceBefore = await mockUSDT.balanceOf(buyer.address);
      const feeRecipientBalanceBefore = await mockUSDT.balanceOf(feeRecipient.address);

      await bscEscrow.connect(bridgeAdmin).releaseUSDTForBuyer(pioneTradeId);

      const buyerBalanceAfter = await mockUSDT.balanceOf(buyer.address);
      const feeRecipientBalanceAfter = await mockUSDT.balanceOf(feeRecipient.address);

      // Verify amounts
      const feePercent = await bscEscrow.feePercent();
      const expectedFee = (TRADE_USDT_AMOUNT * feePercent) / 10000n;
      const expectedBuyerAmount = TRADE_USDT_AMOUNT - expectedFee;

      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(expectedBuyerAmount);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);

      console.log("✓ BSC: USDT released to buyer");
      console.log("  - Buyer received:", ethers.formatUnits(expectedBuyerAmount, USDT_DECIMALS), "USDT");
      console.log("  - Fee collected:", ethers.formatUnits(expectedFee, USDT_DECIMALS), "USDT");

      // Verify trade is completed
      const trade = await bscEscrow.getSellUSDTTrade(pioneTradeId);
      expect(trade.status).to.equal(2); // TradeStatus.Paid
    });

    it("Should handle trade cancellation properly", async function () {
      // Create order
      const tx1 = await bscEscrow.connect(bscSeller).createOrder(
        USDT_AMOUNT,
        USDT_MIN_PER_TRADE,
        USDT_MAX_PER_TRADE,
        PRICE_PER_PIO
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return bscEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      bscOrderId = bscEscrow.interface.parseLog(event1).args.orderId;

      // Create trade
      pioneTradeId = ethers.keccak256(ethers.toUtf8Bytes("pione_trade_002"));
      await bscEscrow.connect(bridgeAdmin).createTrade(
        pioneTradeId,
        bscOrderId,
        buyer.address,
        TRADE_USDT_AMOUNT
      );

      // Cancel trade (buyer didn't pay on Pione)
      await bscEscrow.connect(bridgeAdmin).cancelTrade(pioneTradeId);

      console.log("✓ BSC: Trade cancelled");

      // Verify USDT is unlocked back to order
      const order = await bscEscrow.getOrder(bscOrderId);
      expect(order.availableUSDT).to.equal(USDT_AMOUNT);

      const trade = await bscEscrow.getSellUSDTTrade(pioneTradeId);
      expect(trade.status).to.equal(4); // TradeStatus.Cancelled
    });
  });

  describe("Scenario 3: Buy PIO Flow (User on Pione wants to buy USDT)", function () {
    let bscOrderId, pioneTradeId;
    const LOCK_PIO_AMOUNT = ethers.parseEther("600"); // Lock 600 PIO

    it("Should complete buy PIO flow: Lock PIO on Pione → Release to USDT seller on BSC", async function () {
      // Step 1: USDT seller creates order on BSC
      const tx1 = await bscEscrow.connect(bscSeller).createOrder(
        USDT_AMOUNT,
        USDT_MIN_PER_TRADE,
        USDT_MAX_PER_TRADE,
        PRICE_PER_PIO
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return bscEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      bscOrderId = bscEscrow.interface.parseLog(event1).args.orderId;

      console.log("✓ BSC: USDT seller created order:", bscOrderId);

      // Step 2: PIO buyer on Pione creates trade request and locks PIO
      const tx2 = await pioneEscrow.connect(buyer).createTradeRequest(
        bscOrderId,
        bscSellerOnPione.address, // USDT seller's address on Pione (to receive PIO)
        { value: LOCK_PIO_AMOUNT }
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(log => {
        try {
          return pioneEscrow.interface.parseLog(log).name === "TradeRequestCreated";
        } catch (e) {
          return false;
        }
      });
      pioneTradeId = pioneEscrow.interface.parseLog(event2).args.tradeId;

      console.log("✓ Pione: Buyer locked PIO, trade ID:", pioneTradeId);

      // Verify PIO is locked in contract
      const contractBalance = await ethers.provider.getBalance(await pioneEscrow.getAddress());
      expect(contractBalance).to.equal(LOCK_PIO_AMOUNT);

      // Step 3: Bridge confirms and releases USDT to buyer on BSC
      // (In real scenario, USDT would be released from the order on BSC)

      // Step 4: Bridge releases locked PIO to USDT seller on Pione
      const sellerBalanceBefore = await ethers.provider.getBalance(bscSellerOnPione.address);
      const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient.address);

      await pioneEscrow.connect(bridgeAdmin).releasePIOForSeller(pioneTradeId);

      const sellerBalanceAfter = await ethers.provider.getBalance(bscSellerOnPione.address);
      const feeRecipientBalanceAfter = await ethers.provider.getBalance(feeRecipient.address);

      // Verify amounts
      const feePercent = await pioneEscrow.feePercent();
      const expectedFee = (LOCK_PIO_AMOUNT * feePercent) / 10000n;
      const expectedSellerAmount = LOCK_PIO_AMOUNT - expectedFee;

      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(expectedSellerAmount);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);

      console.log("✓ Pione: PIO released to USDT seller");
      console.log("  - Seller received:", ethers.formatEther(expectedSellerAmount), "PIO");
      console.log("  - Fee collected:", ethers.formatEther(expectedFee), "PIO");
    });

    it("Should handle trade request cancellation and refund PIO to buyer", async function () {
      // Create USDT order on BSC
      const tx1 = await bscEscrow.connect(bscSeller).createOrder(
        USDT_AMOUNT,
        USDT_MIN_PER_TRADE,
        USDT_MAX_PER_TRADE,
        PRICE_PER_PIO
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return bscEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      bscOrderId = bscEscrow.interface.parseLog(event1).args.orderId;

      // Lock PIO on Pione
      const tx2 = await pioneEscrow.connect(buyer).createTradeRequest(
        bscOrderId,
        bscSellerOnPione.address,
        { value: LOCK_PIO_AMOUNT }
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(log => {
        try {
          return pioneEscrow.interface.parseLog(log).name === "TradeRequestCreated";
        } catch (e) {
          return false;
        }
      });
      pioneTradeId = pioneEscrow.interface.parseLog(event2).args.tradeId;

      // Cancel trade request
      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
      await pioneEscrow.connect(bridgeAdmin).cancelRequest(pioneTradeId);
      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);

      // Verify PIO is refunded
      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(LOCK_PIO_AMOUNT);

      console.log("✓ Pione: Trade request cancelled, PIO refunded to buyer");
    });
  });

  describe("Scenario 4: Buy USDT Flow (User on BSC wants to buy PIO)", function () {
    let pioneOrderId, bscTradeId;
    const LOCK_USDT_AMOUNT = ethers.parseUnits("300", USDT_DECIMALS);

    it("Should complete buy USDT flow: Lock USDT on BSC → Release to PIO seller on Pione", async function () {
      // Step 1: PIO seller creates order on Pione
      const tx1 = await pioneEscrow.connect(pioneSeller).createOrder(
        PIO_MIN_PER_TRADE,
        PIO_MAX_PER_TRADE,
        PRICE_PER_PIO,
        { value: PIO_AMOUNT }
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      pioneOrderId = pioneEscrow.interface.parseLog(event1).args.orderId;

      console.log("✓ Pione: PIO seller created order:", pioneOrderId);

      // Step 2: USDT buyer on BSC creates trade request and locks USDT
      const tx2 = await bscEscrow.connect(buyer).createTradeRequest(
        pioneOrderId,
        pioneSellerOnBSC.address, // PIO seller's address on BSC (to receive USDT)
        LOCK_USDT_AMOUNT
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(log => {
        try {
          return bscEscrow.interface.parseLog(log).name === "TradeRequestCreated";
        } catch (e) {
          return false;
        }
      });
      bscTradeId = bscEscrow.interface.parseLog(event2).args.tradeId;

      console.log("✓ BSC: Buyer locked USDT, trade ID:", bscTradeId);

      // Verify USDT is locked in contract
      const contractBalance = await mockUSDT.balanceOf(await bscEscrow.getAddress());
      expect(contractBalance).to.equal(LOCK_USDT_AMOUNT);

      // Step 3: Bridge releases locked USDT to PIO seller on BSC
      const sellerBalanceBefore = await mockUSDT.balanceOf(pioneSellerOnBSC.address);
      const feeRecipientBalanceBefore = await mockUSDT.balanceOf(feeRecipient.address);

      await bscEscrow.connect(bridgeAdmin).releaseUSDTForSeller(bscTradeId);

      const sellerBalanceAfter = await mockUSDT.balanceOf(pioneSellerOnBSC.address);
      const feeRecipientBalanceAfter = await mockUSDT.balanceOf(feeRecipient.address);

      // Verify amounts
      const feePercent = await bscEscrow.feePercent();
      const expectedFee = (LOCK_USDT_AMOUNT * feePercent) / 10000n;
      const expectedSellerAmount = LOCK_USDT_AMOUNT - expectedFee;

      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(expectedSellerAmount);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);

      console.log("✓ BSC: USDT released to PIO seller");
      console.log("  - Seller received:", ethers.formatUnits(expectedSellerAmount, USDT_DECIMALS), "USDT");
      console.log("  - Fee collected:", ethers.formatUnits(expectedFee, USDT_DECIMALS), "USDT");
    });

    it("Should handle trade request cancellation and refund USDT to buyer", async function () {
      // Create PIO order on Pione
      const tx1 = await pioneEscrow.connect(pioneSeller).createOrder(
        PIO_MIN_PER_TRADE,
        PIO_MAX_PER_TRADE,
        PRICE_PER_PIO,
        { value: PIO_AMOUNT }
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(log => {
        try {
          return pioneEscrow.interface.parseLog(log).name === "OrderCreated";
        } catch (e) {
          return false;
        }
      });
      pioneOrderId = pioneEscrow.interface.parseLog(event1).args.orderId;

      // Lock USDT on BSC
      const tx2 = await bscEscrow.connect(buyer).createTradeRequest(
        pioneOrderId,
        pioneSellerOnBSC.address,
        LOCK_USDT_AMOUNT
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(log => {
        try {
          return bscEscrow.interface.parseLog(log).name === "TradeRequestCreated";
        } catch (e) {
          return false;
        }
      });
      bscTradeId = bscEscrow.interface.parseLog(event2).args.tradeId;

      // Cancel trade request
      const buyerBalanceBefore = await mockUSDT.balanceOf(buyer.address);
      await bscEscrow.connect(bridgeAdmin).cancelRequest(bscTradeId);
      const buyerBalanceAfter = await mockUSDT.balanceOf(buyer.address);

      // Verify USDT is refunded
      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(LOCK_USDT_AMOUNT);

      console.log("✓ BSC: Trade request cancelled, USDT refunded to buyer");
    });
  });
});
