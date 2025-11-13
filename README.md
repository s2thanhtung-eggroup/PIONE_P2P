# P2P Crosschain Escrow System - Technical Documentation

## 📋 Tổng Quan Hệ Thống

Hệ thống P2P Crosschain Escrow được thiết kế để hỗ trợ giao dịch ngang hàng (P2P) giữa hai blockchain:
- **BSC Chain (Binance Smart Chain)**: Quản lý USDT thông qua contract `BSCP2PEscrow`
- **Pione Chain**: Quản lý PIO token thông qua contract `PioneP2PEscrow`

### Kiến Trúc Tổng Quan

```
┌─────────────────────────────────────────────────────────────────┐
│                     P2P CROSSCHAIN SYSTEM                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────┐         ┌──────────────────────┐      │
│  │   BSC Chain          │         │   Pione Chain        │      │
│  │  BSCP2PEscrow        │◄───────►│  PioneP2PEscrow      │      │
│  │  (USDT)              │         │  (PIO)               │      │
│  └──────────────────────┘         └──────────────────────┘      │
│           ▲                                 ▲                   │
│           │                                 │                   │
│           └────────── Bridge Admin ─────────┘                   │
│                    (Synchronization)                            │
└─────────────────────────────────────────────────────────────────┘
```

## 🔑 Các Thành Phần Chính

### 1. BSCP2PEscrow (BSC Chain)
**Trách nhiệm**: Quản lý USDT và xử lý giao dịch trên BSC
- Địa chỉ USDT token
- Địa chỉ PIO token (cho việc tính toán giá)
- PancakeSwap pair (cho oracle giá)
- Fee receiver address

### 2. PioneP2PEscrow (Pione Chain)
**Trách nhiệm**: Quản lý native PIO token và xử lý giao dịch trên Pione
- Price Oracle interface
- Fee receiver address

### 3. Bridge Admin
**Trách nhiệm**: Đồng bộ hóa trạng thái giao dịch giữa 2 chains
- Có quyền `BRIDGE_ADMIN_ROLE` trên cả 2 contracts
- Tạo trades dựa trên requests từ chain khác
- Release assets sau khi xác nhận payment
- Đồng bộ expiration và cancellation

## 📊 Các Cấu Trúc Dữ Liệu

### Order Status
```solidity
enum OrderStatus {
    None,       // Không tồn tại
    Active,     // Đang hoạt động
    Completed,  // Đã hoàn thành
    Cancelled,  // Đã hủy
    Expired     // Đã hết hạn
}
```

### Trade Status
```solidity
enum TradeStatus {
    None,       // Không tồn tại
    Created,    // Đã tạo, đang chờ xử lý
    Paid,       // Đã thanh toán/hoàn thành
    Expired,    // Đã hết hạn
    Cancelled   // Đã hủy
}
```

### Order Structure (Pione Chain)
```solidity
struct Order {
    address seller;         // Người bán PIO
    uint256 totalPIO;       // Tổng số PIO trong order
    uint256 availablePIO;   // Số PIO còn available
    uint256 minPerTrade;    // Số lượng tối thiểu mỗi giao dịch
    uint256 maxPerTrade;    // Số lượng tối đa mỗi giao dịch
    uint256 pricePerPIO;    // Giá mỗi PIO (in USDT)
    OrderStatus status;     // Trạng thái order
}
```

### Order Structure (BSC Chain)
```solidity
struct Order {
    address seller;         // Người bán USDT
    uint256 totalUSDT;      // Tổng số USDT trong order
    uint256 availableUSDT;  // Số USDT còn available
    uint256 minPerTrade;    // Số lượng tối thiểu mỗi giao dịch
    uint256 maxPerTrade;    // Số lượng tối đa mỗi giao dịch
    uint256 pricePerPIO;    // Giá mỗi PIO (in USDT)
    OrderStatus status;     // Trạng thái order
}
```

## 🔄 Flow Hoạt Động Chi Tiết

---

## FLOW 1: MUA PIO (Sell USDT - Buy PIO)

### Tổng Quan
User trên BSC muốn mua PIO token từ seller trên Pione chain bằng USDT.

### Sequence Flow

```
User (BSC)          BSCP2PEscrow        Bridge Admin        PioneP2PEscrow      Seller (Pione)
    │                      │                   │                    │                  │
    │                      │                   │                    │                  │
    │  1. Seller tạo Order trên Pione Chain                         │                  │
    │                      │                   │                    │◄─────────────────┤
    │                      │                   │                    │  createOrder()   │
    │                      │                   │                    │  + Lock PIO      │
    │                      │                   │                    │                  │
    │  2. Buyer tạo Trade Request trên BSC                          │                  │
    ├──────────────────────►                   │                    │                  │
    │ createTradeRequest() │                   │                    │                  │
    │ + Lock USDT          │                   │                    │                  │
    │                      │                   │                    │                  │
    │  3. Bridge Admin tạo Trade trên Pione                         │                  │
    │                      │                   ├────────────────────►                  │
    │                      │                   │  createTrade()     │                  │
    │                      │                   │  (lock PIO from    │                  │
    │                      │                   │   seller's order)  │                  │
    │                      │                   │                    │                  │
    │  4. Bridge Admin release PIO cho Buyer                        │                  │
    │                      │                   ├────────────────────►                  │
    │                      │                   │ releasePIOForBuyer()                  │
    │                      │                   │  - Deduct fee      │                  │
    │                      │                   │  - Send PIO to buyer                  │
    │                      │                   │                    │                  │
    │  5. Bridge Admin release USDT cho Seller                      │                  │
    │                      │◄──────────────────┤                    │                  │
    │                      │ releaseUSDTForSeller()                 │                  │
    │                      │  - Deduct fee     │                    │                  │
    │                      │  - Send USDT to seller ───────────────────────────────────►
    │                      │                   │                    │                  │
```

### Chi Tiết Các Bước

#### Bước 1: Seller tạo Order trên Pione Chain
**Function**: `PioneP2PEscrow.createOrder()`

```solidity
function createOrder(
    uint256 _minPerTrade,
    uint256 _maxPerTrade,
    uint256 _pricePerPIO
) external payable returns (bytes32 orderId)
```

**Điều kiện:**
- `msg.value >= minPioForSell` - Số PIO phải đủ lớn
- `_maxPerTrade > _minPerTrade` - Range hợp lệ
- `_pricePerPIO` phải trong khoảng tolerance của oracle price (±10% default)

**Xử lý:**
1. Validate số lượng PIO và price range
2. Tạo `orderId` unique từ hash của (seller, amount, counter, timestamp)
3. Lock PIO (msg.value) vào contract
4. Lưu Order struct với status = Active
5. Thêm orderId vào danh sách orders của seller

**Events**: `OrderCreated`

---

#### Bước 2: Buyer tạo Trade Request trên BSC
**Function**: `BSCP2PEscrow.createTradeRequest()`

```solidity
function createTradeRequest(
    bytes32 _pioneOrderId,
    address _seller,
    uint256 _usdtAmount
) external returns (bytes32 tradeId)
```

**Input:**
- `_pioneOrderId`: ID của order trên Pione chain
- `_seller`: Địa chỉ seller trên Pione chain
- `_usdtAmount`: Số USDT buyer muốn trade

**Điều kiện:**
- User phải approve USDT trước
- `_usdtAmount > 0`
- Trade chưa tồn tại

**Xử lý:**
1. Tạo unique `tradeId` từ hash
2. Transfer USDT từ buyer vào contract (lock USDT)
3. Tạo `BuyPIOTrade` struct:
   - `pioneOrderId`: Link đến order trên Pione
   - `seller`: Địa chỉ seller PIO
   - `buyer`: msg.sender
   - `usdtAmount`: Số USDT đã lock
   - `feeSnapshot`: Fee rate tại thời điểm tạo
   - `status`: Created
4. Thêm tradeId vào danh sách trades của buyer

**Events**: `TradeRequestCreated`

**State**: USDT được lock trong contract, đợi Bridge Admin xử lý

---

#### Bước 3: Bridge Admin tạo Trade trên Pione Chain
**Function**: `PioneP2PEscrow.createTrade()`

```solidity
function createTrade(
    bytes32 _bscTradeId,
    bytes32 _orderId,
    address _buyer,
    uint256 _pioAmount
) external onlyBridgeAdmin returns (bool)
```

**Input:**
- `_bscTradeId`: ID của trade request trên BSC
- `_orderId`: ID của order trên Pione
- `_buyer`: Địa chỉ buyer (để receive PIO sau này)
- `_pioAmount`: Số PIO sẽ trade

**Điều kiện:**
- Order phải Active
- `_pioAmount <= order.availablePIO`
- `_pioAmount` phải trong range [minPerTrade, maxPerTrade]
- Trade với `_bscTradeId` chưa tồn tại

**Xử lý:**
1. Giảm `order.availablePIO` (lock PIO từ order)
2. Tính `usdtAmount = (_pioAmount * order.pricePerPIO) / 1e18`
3. Tạo `SellPIOTrade` struct:
   - `orderId`: Link đến order
   - `seller`: Từ order
   - `buyer`: Buyer address
   - `pioAmount`: Số PIO đã lock
   - `pricePerPIO`: Giá snapshot
   - `feeSnapshot`: Fee rate
   - `status`: Created
4. Link trade với order

**Events**: `TradeCreated`

**State**: PIO từ order đã bị lock, sẵn sàng release cho buyer

---

#### Bước 4: Bridge Admin release PIO cho Buyer
**Function**: `PioneP2PEscrow.releasePIOForBuyer()`

```solidity
function releasePIOForBuyer(bytes32 _tradeId)
    external
    onlyBridgeAdmin
    nonReentrant
```

**Điều kiện:**
- Trade status = Created
- Bridge Admin đã verify USDT locked trên BSC

**Xử lý:**
1. Tính fee: `fee = (pioAmount * feeSnapshot) / 10000`
2. Tính buyer amount: `buyerAmount = pioAmount - fee`
3. Transfer PIO:
   - Send `buyerAmount` PIO cho buyer
   - Send `fee` cho feeTo address (nếu có)
4. Update trade status = Paid

**Events**: `PIOReleased`

**State**: Buyer đã nhận PIO (trừ fee)

---

#### Bước 5: Bridge Admin release USDT cho Seller
**Function**: `BSCP2PEscrow.releaseUSDTForSeller()`

```solidity
function releaseUSDTForSeller(bytes32 _tradeId)
    external
    onlyBridgeAdmin
    nonReentrant
```

**Điều kiện:**
- Trade status = Created
- Bridge Admin đã verify PIO released trên Pione

**Xử lý:**
1. Tính fee: `fee = (usdtAmount * feeSnapshot) / 10000`
2. Tính seller amount: `sellerAmount = usdtAmount - fee`
3. Transfer USDT:
   - Send `sellerAmount` cho seller
   - Send `fee` cho feeTo address (nếu có)
4. Update trade status = Paid

**Events**: `USDTPaid`

**Kết quả cuối cùng:**
- ✅ Buyer nhận được PIO (trên Pione)
- ✅ Seller nhận được USDT (trên BSC)
- ✅ Platform nhận fee từ cả 2 bên

---

## FLOW 2: BÁN PIO (Buy USDT - Sell PIO)

### Tổng Quan
User trên Pione muốn bán PIO token để nhận USDT từ seller trên BSC chain.

### Sequence Flow

```
User (Pione)      PioneP2PEscrow      Bridge Admin        BSCP2PEscrow       Seller (BSC)
    │                   │                   │                    │                  │
    │                   │                   │                    │                  │
    │  1. Seller tạo Order trên BSC Chain                        │                  │
    │                   │                   │                    │◄─────────────────┤
    │                   │                   │                    │  createOrder()   │
    │                   │                   │                    │  + Lock USDT     │
    │                   │                   │                    │                  │
    │  2. Buyer tạo Trade Request trên Pione                     │                  │
    ├───────────────────►                   │                    │                  │
    │ createTradeRequest()                  │                    │                  │
    │ + Lock PIO        │                   │                    │                  │
    │                   │                   │                    │                  │
    │  3. Bridge Admin tạo Trade trên BSC                        │                  │
    │                   │                   ├────────────────────►                  │
    │                   │                   │  createTrade()     │                  │
    │                   │                   │  (lock USDT from   │                  │
    │                   │                   │   seller's order)  │                  │
    │                   │                   │                    │                  │
    │  4. Bridge Admin release USDT cho Buyer                    │                  │
    │                   │                   ├────────────────────►                  │
    │                   │                   │ releaseUSDTForBuyer()                 │
    │                   │                   │  - Deduct fee      │                  │
    │◄──────────────────┴───────────────────┴────────────────────┤                  │
    │   Receive USDT                        │  - Send USDT       │                  │
    │                   │                   │                    │                  │
    │  5. Bridge Admin release PIO cho Seller                    │                  │
    │                   │◄──────────────────┤                    │                  │
    │                   │ releasePIOForSeller()                  │                  │
    │                   │  - Deduct fee     │                    │                  │
    │                   │  - Send PIO to seller ─────────────────────────────────────►
    │                   │                   │                    │                  │
```

### Chi Tiết Các Bước

#### Bước 1: Seller tạo Order trên BSC Chain
**Function**: `BSCP2PEscrow.createOrder()`

```solidity
function createOrder(
    uint256 _usdtAmount,
    uint256 _minPerTrade,
    uint256 _maxPerTrade,
    uint256 _pricePerPIO
) external returns (bytes32 orderId)
```

**Điều kiện:**
- User phải approve USDT trước
- `_usdtAmount >= minUsdtForSell`
- `_maxPerTrade > _minPerTrade && _maxPerTrade <= _usdtAmount`
- `_pricePerPIO` phải trong khoảng tolerance của PancakeSwap price

**Xử lý:**
1. Validate amount và price range từ PancakeSwap pair
2. Tạo unique `orderId`
3. Transfer USDT từ seller vào contract (lock USDT)
4. Tạo Order struct với status = Active
5. Thêm orderId vào seller's orders

**Events**: `OrderCreated`

---

#### Bước 2: Buyer tạo Trade Request trên Pione Chain
**Function**: `PioneP2PEscrow.createTradeRequest()`

```solidity
function createTradeRequest(
    bytes32 _bscOrderId,
    address _seller
) external payable returns (bytes32 tradeId)
```

**Input:**
- `_bscOrderId`: ID của order trên BSC chain
- `_seller`: Địa chỉ seller trên BSC chain
- `msg.value`: Số PIO buyer muốn bán

**Điều kiện:**
- `msg.value > 0`
- Trade chưa tồn tại

**Xử lý:**
1. Tạo unique `tradeId`
2. Lock PIO (msg.value) trong contract
3. Tạo `BuyUSDTTrade` struct:
   - `bscOrderId`: Link đến order trên BSC
   - `seller`: Địa chỉ USDT seller
   - `buyer`: msg.sender
   - `lockedPIO`: Số PIO đã lock
   - `feeSnapshot`: Fee rate
   - `status`: Created
4. Add to user's trades

**Events**: `TradeRequestCreated`

---

#### Bước 3: Bridge Admin tạo Trade trên BSC
**Function**: `BSCP2PEscrow.createTrade()`

```solidity
function createTrade(
    bytes32 _pioneTradeId,
    bytes32 _orderId,
    address _buyer,
    uint256 _usdtAmount
) external onlyBridgeAdmin returns (bool)
```

**Input:**
- `_pioneTradeId`: ID của trade request trên Pione
- `_orderId`: ID của order trên BSC
- `_buyer`: Địa chỉ buyer (để receive USDT)
- `_usdtAmount`: Số USDT sẽ trade

**Điều kiện:**
- Order phải Active
- `_usdtAmount <= order.availableUSDT`
- `_usdtAmount` trong range [minPerTrade, maxPerTrade]

**Xử lý:**
1. Giảm `order.availableUSDT` (lock USDT)
2. Tạo `SellUSDTTrade` struct với status = Created
3. Link trade với order

**Events**: `TradeCreated`

---

#### Bước 4: Bridge Admin release USDT cho Buyer
**Function**: `BSCP2PEscrow.releaseUSDTForBuyer()`

```solidity
function releaseUSDTForBuyer(bytes32 _tradeId)
    external
    onlyBridgeAdmin
    nonReentrant
```

**Điều kiện:**
- Trade status = Created
- Bridge Admin verify PIO locked trên Pione

**Xử lý:**
1. Tính fee và buyer amount
2. Transfer USDT:
   - `buyerAmount` cho buyer
   - `fee` cho feeTo
3. Update status = Paid

**Events**: `USDTReleased`

---

#### Bước 5: Bridge Admin release PIO cho Seller
**Function**: `PioneP2PEscrow.releasePIOForSeller()`

```solidity
function releasePIOForSeller(bytes32 _tradeId)
    external
    onlyBridgeAdmin
    nonReentrant
```

**Điều kiện:**
- Trade status = Created
- Bridge Admin verify USDT released trên BSC

**Xử lý:**
1. Tính fee và seller amount
2. Transfer PIO:
   - `sellerAmount` cho seller
   - `fee` cho feeTo
3. Update status = Paid

**Events**: `PIOReleased`

**Kết quả:**
- ✅ Buyer nhận USDT (trên BSC)
- ✅ Seller nhận PIO (trên Pione)
- ✅ Platform nhận fee

---

## 🚫 FLOW 3: CANCEL & EXPIRE FLOWS

### 3.1. Cancel Order

**Pione Chain:**
```solidity
function cancelOrder(bytes32 _orderId) external nonReentrant
```

**BSC Chain:**
```solidity
function cancelOrder(bytes32 _orderId) external nonReentrant
```

**Điều kiện:**
- Caller phải là seller hoặc Bridge Admin
- Order status = Active
- Tất cả trades của order phải đã finalized (Paid/Expired/Cancelled)

**Xử lý:**
1. Verify tất cả trades đã finalized
2. Update order status = Cancelled
3. Refund `availablePIO/USDT` cho seller
4. Set availablePIO/USDT = 0

**Use case:** Seller muốn thu hồi order sau khi các trades đã xong

---

### 3.2. Cancel Trade Request

**Function**: `cancelRequest()` (trên cả 2 chains)

**Caller**: Bridge Admin only

**Điều kiện:**
- Trade status = Created
- Chưa có matching trade trên chain kia

**Xử lý:**
- **BSC**: Refund USDT cho buyer
- **Pione**: Refund PIO cho buyer
- Update status = Cancelled

**Events**: `RequestCancelled`

---

### 3.3. Cancel Trade

**Function**: `cancelTrade()` (trên cả 2 chains)

**Caller**: Bridge Admin only

**Điều kiện:**
- Trade status = Created

**Xử lý:**
- **BSC**: Unlock USDT về order (tăng availableUSDT)
- **Pione**: Unlock PIO về order (tăng availablePIO)
- Update status = Cancelled

**Events**: `TradeCancelled`

**Use case:** Bridge Admin hủy trade đã match nhưng chưa complete

---

### 3.4. Expire Trade Request

**Function**: `expireRequest()` (trên cả 2 chains)

**Caller**: Bridge Admin only

**Điều kiện:**
- Trade status = Created
- Trade đã quá timeout period

**Xử lý:**
- **BSC**: Refund USDT cho buyer
- **Pione**: Refund PIO cho buyer
- Update status = Expired
- Set `crossChainExpireSynced[_tradeId] = true`

**Events**: `RequestExpired`

---

### 3.5. Expire Trade

**Function**: `expireTrade()` (trên cả 2 chains)

**Caller**: Bridge Admin only

**Điều kiện:**
- Trade status = Created
- Trade đã quá timeout

**Xử lý:**
- **BSC**: Unlock USDT về order
- **Pione**: Unlock PIO về order
- Update status = Expired
- Set `crossChainExpireSynced[_tradeId] = true`

**Events**: `TradeExpired`

---

### 3.6. Batch Expire Trades

**Function**: `batchExpireTrades(bytes32[] calldata _tradeIds)`

**Caller**: Bridge Admin only

**Mục đích:** Expire nhiều trades cùng lúc để tiết kiệm gas

**Xử lý:**
- Loop qua tất cả tradeIds
- Call internal expire function cho mỗi trade
- Unlock assets về orders tương ứng

---

## 💰 Fee Mechanism

### Fee Structure
- Default fee: 1% (100 basis points)
- Max fee: 10% (1000 basis points)
- Fee được snapshot tại thời điểm tạo trade

### Fee Calculation
```solidity
fee = (amount * feeSnapshot) / 10000
recipientAmount = amount - fee
```

### Fee Distribution
Trên cả 2 chains, fee được thu khi release assets:
1. Tính fee từ total amount
2. Transfer (amount - fee) cho recipient
3. Transfer fee cho `feeTo` address

### Disable Fee
Set `feeTo = address(0)` → fee = 0 cho các trades mới

---

## 🔒 Security Features

### 1. Access Control
```solidity
- DEFAULT_ADMIN_ROLE: Full admin
- ADMIN_ROLE: Config parameters
- BRIDGE_ADMIN_ROLE: Crosschain operations
```

### 2. ReentrancyGuard
Tất cả functions transfer assets có `nonReentrant` modifier

### 3. Pausable
Admin có thể pause/unpause contracts khi cần

### 4. Price Validation
- Oracle price (Pione) hoặc PancakeSwap price (BSC)
- Price tolerance: ±10% default
- Sellers không thể set giá quá xa market price

### 5. Amount Validation
- Min/max per trade limits
- Total amount checks
- Available balance checks

---

## 📐 Price Oracle System

### Pione Chain
Sử dụng `IPriceOracle` interface:
```solidity
interface IPriceOracle {
    function nativePriceInUSD() external view returns (uint256 price);
}
```

### BSC Chain
Sử dụng PancakeSwap Pair để tính giá:
```solidity
function getCurrentPIOPrice() public view returns (uint256) {
    IPancakePair pair = IPancakePair(pancakePairAddress);
    (uint112 r0, uint112 r1,) = pair.getReserves();

    (uint256 pioReserve, uint256 usdtReserve) = pair.token0() == pioTokenAddress
        ? (r0, r1)
        : (r1, r0);

    return (usdtReserve * 1e18) / pioReserve;
}
```

### Price Range Validation
```solidity
uint256 currentPrice = getCurrentPIOPrice();
uint256 minPrice = (currentPrice * (10000 - priceTolerancePercent)) / 10000;
uint256 maxPrice = (currentPrice * (10000 + priceTolerancePercent)) / 10000;
```

---

## 🔄 Bridge Admin Responsibilities

### 1. Monitoring
- Lắng nghe events từ cả 2 chains
- Detect trade requests cần xử lý
- Monitor timeouts

### 2. Trade Matching
- Verify trade request trên chain A
- Create corresponding trade trên chain B
- Ensure atomic execution

### 3. Asset Release
- Verify assets locked trên cả 2 chains
- Release assets theo đúng thứ tự
- Handle fees correctly

### 4. Expiration Management
- Detect expired trades
- Synchronize expiration trạng thái
- Refund assets to users

### 5. Error Handling
- Cancel invalid trades
- Resolve disputes
- Handle edge cases

---

## 📊 State Management

### Order Lifecycle
```
None → Active → Completed/Cancelled
              ↓
           (trades) → Finalized
```

### Trade Lifecycle
```
None → Created → Paid
              ↓
           Expired/Cancelled
```

### Synchronization Points
1. **Trade Creation**: BSC trade request → Pione trade (hoặc ngược lại)
2. **Asset Release**: Confirm trên chain A → Release trên chain B
3. **Expiration**: Expire trên chain A → Sync expire trên chain B

---

## 🔍 Helper Functions

### Query Functions

#### Get Order Info
```solidity
function getOrder(bytes32 _orderId) external view returns (Order memory)
```

#### Get Trade Info
```solidity
// BSC
function getBuyPIOTrade(bytes32 _tradeId) external view returns (BuyPIOTrade memory)
function getSellUSDTTrade(bytes32 _tradeId) external view returns (SellUSDTTrade memory)

// Pione
function getSellPIOTrade(bytes32 _tradeId) external view returns (SellPIOTrade memory)
function getBuyUSDTTrade(bytes32 _tradeId) external view returns (BuyUSDTTrade memory)
```

#### Get User Orders/Trades
```solidity
function getSellerOrders(address _seller) external view returns (bytes32[] memory)
function getUserTrades(address _user) external view returns (bytes32[] memory)
function getOrderTrades(bytes32 _orderId) external view returns (bytes32[] memory)
```

### Utility Functions

#### Estimate Amounts
```solidity
// BSC
function estimateUSDTForOrder(bytes32 _orderId, uint256 _pioAmount) external view returns (uint256)
function estimatePIOAmount(uint256 _usdtAmount) external view returns (uint256)

// Pione
function estimatePIOAmount(uint256 _usdtAmount) external view returns (uint256)
```

#### Get Price Info
```solidity
function getCurrentPIOPrice() external view returns (uint256)
function getPriceRange() external view returns (uint256 minPrice, uint256 maxPrice, uint256 currentPrice)
```

---

## ⚙️ Admin Configuration

### Update Fee
```solidity
function updateFee(uint16 _newFee) external onlyRole(ADMIN_ROLE)
// Max 1000 (10%)
```

### Update Fee Recipient
```solidity
function updateFeeTo(address _newFeeTo) external onlyRole(ADMIN_ROLE)
// Set to address(0) to disable fees
```

### Update Price Tolerance
```solidity
function updatePriceTolerance(uint16 _newTolerance) external onlyRole(ADMIN_ROLE)
// Default 1000 (10%)
```

### Update Min Amounts
```solidity
// BSC
function updateMinUsdtForSell(uint256 _newMin) external onlyRole(ADMIN_ROLE)

// Pione
function updateMinPioForSell(uint256 _newMin) external onlyRole(ADMIN_ROLE)
```

### Update Oracle/Pair
```solidity
// BSC
function updatePancakePair(address _newPair) external onlyRole(ADMIN_ROLE)

// Pione
function updateOracle(address _newOracle) external onlyRole(ADMIN_ROLE)
```

### Seller Functions

#### Update Order Limits
```solidity
function updateOrderLimits(
    bytes32 _orderId,
    uint256 _newMinPerTrade,
    uint256 _newMaxPerTrade
) external
// Chỉ seller của order có thể call
```

#### Update Order Price
```solidity
function updateOrderPrice(
    bytes32 _orderId,
    uint256 _newPricePerPIO
) external
// Price phải trong tolerance range
```

---

## 🎯 Use Cases & Examples

### Example 1: User mua 100 PIO với giá 1.5 USDT/PIO

**Bước thực hiện:**

1. **Seller tạo order trên Pione:**
   ```
   createOrder(
       minPerTrade: 50 PIO,
       maxPerTrade: 500 PIO,
       pricePerPIO: 1.5e18
   ) payable { value: 1000 PIO }
   ```

2. **Buyer tạo request trên BSC:**
   ```
   createTradeRequest(
       pioneOrderId: 0x123...,
       seller: 0xSeller...,
       usdtAmount: 150 USDT
   )
   → Lock 150 USDT
   ```

3. **Bridge Admin match:**
   ```
   PioneP2PEscrow.createTrade(
       bscTradeId: 0xabc...,
       orderId: 0x123...,
       buyer: 0xBuyer...,
       pioAmount: 100 PIO
   )
   → Lock 100 PIO from order
   ```

4. **Bridge Admin release PIO:**
   ```
   PioneP2PEscrow.releasePIOForBuyer(0xabc...)
   → Buyer receives: 99 PIO (1 PIO fee)
   → Fee recipient: 1 PIO
   ```

5. **Bridge Admin release USDT:**
   ```
   BSCP2PEscrow.releaseUSDTForSeller(0xabc...)
   → Seller receives: 148.5 USDT (1.5 USDT fee)
   → Fee recipient: 1.5 USDT
   ```

**Kết quả:**
- Buyer: -150 USDT, +99 PIO
- Seller: +148.5 USDT, -100 PIO
- Platform: +1.5 USDT, +1 PIO

---

### Example 2: User bán 200 PIO để nhận USDT

**Bước thực hiện:**

1. **Seller tạo order trên BSC:**
   ```
   createOrder(
       usdtAmount: 1000 USDT,
       minPerTrade: 100 USDT,
       maxPerTrade: 500 USDT,
       pricePerPIO: 1.5e18
   )
   → Lock 1000 USDT
   ```

2. **Buyer tạo request trên Pione:**
   ```
   createTradeRequest(
       bscOrderId: 0x456...,
       seller: 0xSeller...
   ) payable { value: 200 PIO }
   → Lock 200 PIO
   ```

3. **Bridge Admin match:**
   ```
   BSCP2PEscrow.createTrade(
       pioneTradeId: 0xdef...,
       orderId: 0x456...,
       buyer: 0xBuyer...,
       usdtAmount: 300 USDT
   )
   → Lock 300 USDT from order
   ```

4. **Bridge Admin release USDT:**
   ```
   BSCP2PEscrow.releaseUSDTForBuyer(0xdef...)
   → Buyer receives: 297 USDT (3 USDT fee)
   ```

5. **Bridge Admin release PIO:**
   ```
   PioneP2PEscrow.releasePIOForSeller(0xdef...)
   → Seller receives: 198 PIO (2 PIO fee)
   ```

**Kết quả:**
- Buyer: -200 PIO, +297 USDT
- Seller: +198 PIO, -300 USDT
- Platform: +3 USDT, +2 PIO

---

## 🚨 Edge Cases & Error Handling

### 1. Insufficient Liquidity
**Scenario**: Order không đủ available amount

**Handling**:
- `createTrade()` sẽ revert với "Insufficient PIO/USDT"
- Bridge Admin phải tìm order khác hoặc reject request

### 2. Price Change During Trade
**Scenario**: Market price thay đổi nhiều trong quá trình trade

**Handling**:
- Price được snapshot tại thời điểm tạo order
- Trade sử dụng snapshot price, không bị ảnh hưởng
- Seller có thể update price nếu order chưa có trades

### 3. Trade Timeout
**Scenario**: User không complete trade trong thời gian quy định

**Handling**:
- Bridge Admin call `expireRequest()` hoặc `expireTrade()`
- Assets được refund về users
- Status update = Expired

### 4. User Cancel Sau Khi Lock Assets
**Scenario**: User muốn cancel sau khi đã lock assets

**Handling**:
- User không thể tự cancel
- Phải đợi Bridge Admin call `cancelRequest()`
- Assets được refund

### 5. Network Issues
**Scenario**: Transaction thất bại trên một chain

**Handling**:
- Bridge Admin retry transaction
- Hoặc cancel và refund assets
- Maintain consistency giữa 2 chains

### 6. Double Release Prevention
**Scenario**: Nguy cơ release assets 2 lần

**Handling**:
- Trade status check trước khi release
- `nonReentrant` modifier
- Update status ngay sau release

---

## 📈 Gas Optimization

### Batch Operations
```solidity
function batchExpireTrades(bytes32[] calldata _tradeIds)
```
→ Expire nhiều trades cùng lúc

### Storage Packing
- Enums dùng uint8
- Fee percent dùng uint16
- Minimize storage slots

### View Functions
Tất cả query functions là `view` → không tốn gas

---

## 🔐 Security Recommendations

### For Users
1. ✅ Approve đúng amount trước khi trade
2. ✅ Verify order info trước khi create request
3. ✅ Check price range hợp lý
4. ✅ Monitor trade status

### For Bridge Admin
1. ✅ Verify events từ cả 2 chains
2. ✅ Double-check amounts trước khi release
3. ✅ Handle timeouts promptly
4. ✅ Keep private keys secure
5. ✅ Use multisig for admin operations

### For Developers
1. ✅ Regular security audits
2. ✅ Monitor oracle price feeds
3. ✅ Test edge cases thoroughly
4. ✅ Implement circuit breakers
5. ✅ Have emergency pause mechanism

---

## 📝 Events Summary

### Order Events
- `OrderCreated`: Order mới được tạo
- `OrderCancelled`: Order bị cancel

### Trade Events
- `TradeCreated`: Trade mới được tạo từ order
- `TradeRequestCreated`: User tạo trade request
- `TradeCancelled`: Trade bị cancel
- `TradeExpired`: Trade hết hạn

### Asset Events
- `PIOReleased`: PIO được release
- `USDTReleased`: USDT được release cho buyer
- `USDTPaid`: USDT được paid cho seller

### Request Events
- `RequestCancelled`: Request bị cancel
- `RequestExpired`: Request hết hạn

### Config Events
- `PriceToleranceUpdated`
- `MinUsdtForSellUpdated`
- `MinPioForSellUpdated`
- `FeeToUpdated`

---

## 🎓 Glossary

- **Order**: Lệnh bán assets (PIO hoặc USDT) của seller
- **Trade**: Giao dịch được match từ order
- **Trade Request**: Yêu cầu giao dịch từ buyer, chờ Bridge Admin match
- **Lock**: Giữ assets trong contract
- **Release**: Chuyển assets cho recipient
- **Bridge Admin**: Entity đồng bộ hóa state giữa 2 chains
- **Snapshot**: Giá trị được lưu tại thời điểm cụ thể (price, fee)
- **Available**: Số lượng assets trong order chưa bị lock
- **Finalized**: Trade đã complete hoặc cancel/expire

---

## 🔄 Complete Flow Diagrams

### Overall System Architecture
```
┌─────────────────────────────────────────────────────────────────────┐
│                        P2P CROSSCHAIN ESCROW                        │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────┐                                ┌──────────────────┐
│   BSC CHAIN      │                                │  PIONE CHAIN     │
│                  │                                │                  │
│  BSCP2PEscrow    │◄──────────────────────────────►│ PioneP2PEscrow   │
│                  │      Bridge Admin              │                  │
│  - USDT Token    │      Synchronization           │  - Native PIO    │
│  - PancakeSwap   │                                │  - Price Oracle  │
│    Price Oracle  │                                │                  │
└──────────────────┘                                └──────────────────┘
       │                                                     │
       │                                                     │
   ┌───┴────┐                                           ┌───┴────┐
   │ Users  │                                           │ Users  │
   │ Buyers │                                           │ Sellers│
   │ Sellers│                                           │ Buyers │
   └────────┘                                           └────────┘
```

---

## ✅ Summary

Hệ thống P2P Crosschain Escrow cung cấp:

1. **Atomic Swaps**: Giao dịch an toàn giữa PIO và USDT trên 2 chains khác nhau
2. **Escrow Protection**: Assets được lock an toàn trong contracts
3. **Flexible Orders**: Sellers có thể tạo orders với custom price và limits
4. **Fee System**: Thu phí công bằng từ cả buyer và seller
5. **Admin Control**: Bridge Admin đảm bảo đồng bộ giữa 2 chains
6. **Emergency Handling**: Pause, cancel, expire mechanisms
7. **Price Protection**: Validate price theo oracle để tránh manipulation
8. **Query Functions**: Đầy đủ functions để theo dõi orders và trades

System được thiết kế để an toàn, hiệu quả và user-friendly cho P2P trading giữa 2 blockchain ecosystems.