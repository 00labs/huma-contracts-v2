// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IDealPortfolioPool} from "./interfaces/IDealPortfolioPool.sol";

struct EpochOrder {
    uint96 totalDeposit;
    uint96 totalRedeemShare;
}

struct EpochInfo {
    uint64 epochId;
    uint96 depositFulfillment;
    uint96 redeemFulfillment;
    uint256 tokenPrice;
}

struct UserOrder {
    uint64 epochIndex;
    uint96 depositAmount;
    uint96 redeemShare;
}

contract TrancheVault is ERC20 {
    IDealPortfolioPool public portfolioPool;
    uint256 public index;

    EpochOrder internal _epochOrder;
    EpochInfo[] public epochs;
    mapping(address => UserOrder) public orders;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function totalAssets() public view returns (uint256) {
        return portfolioPool.trancheTotalAssets(index);
    }

    function epochOrder() external view returns (uint256 totalDeposit, uint256 totalRedeemShare) {
        EpochOrder memory eo = _epochOrder;
        totalDeposit = eo.totalDeposit;
        totalRedeemShare = eo.totalRedeemShare;
    }

    function closeEpoch(uint256 epochId, uint256 price, uint256[4] memory data) external {
        // check permission

        EpochInfo memory ei;
        ei.epochId = uint64(epochId);
        ei.tokenPrice = price;
        ei.depositFulfillment = uint96(data[1] / data[0]);
        ei.redeemFulfillment = uint96(data[3] / data[2]);
        epochs.push(ei);

        // deposit/withdraw from reserve
        // mint/burn token

        EpochOrder memory eo;
        eo.totalDeposit = eo.totalDeposit - uint96(data[1]);
        eo.totalRedeemShare = eo.totalRedeemShare - uint96(data[3] / price);
        _epochOrder = eo;
    }

    function makeDepositOrder(uint256 amount) external {
        _orderAllowed(msg.sender);
        UserOrder memory order = orders[msg.sender];
        uint256 oldDepositAmount = order.depositAmount;
        order.depositAmount = uint96(amount);
        order.epochIndex = uint64(epochs.length);
        orders[msg.sender] = order;
        EpochOrder memory eo = _epochOrder;
        eo.totalDeposit = eo.totalDeposit - uint96(oldDepositAmount) + uint96(amount);
        _epochOrder = eo;
        // transfer delta from/to msg.sender
    }

    function makeRedeemOrder(uint256 share) external {
        _orderAllowed(msg.sender);
        UserOrder memory order = orders[msg.sender];
        uint256 oldRedeemShare = order.redeemShare;
        order.redeemShare = uint96(share);
        order.epochIndex = uint64(epochs.length);
        orders[msg.sender] = order;
        EpochOrder memory eo = _epochOrder;
        eo.totalRedeemShare = eo.totalRedeemShare - uint96(oldRedeemShare) + uint96(share);
        _epochOrder = eo;
        // transfer delta from/to msg.sender
    }

    function disburse() external {
        // check permissions

        UserOrder memory order = orders[msg.sender];
        uint256[] memory payouts;
        (payouts, order) = _calculateDisburse(order);
        orders[msg.sender] = order;

        // disburse payouts
    }

    function _orderAllowed(address account) internal view {}

    function _calculateDisburse(
        UserOrder memory order
    ) internal view returns (uint256[] memory payouts, UserOrder memory newOrder) {
        uint256 remainingDepositAmount = order.depositAmount;
        uint256 remainingRedeemShare = order.redeemShare;
        payouts = new uint256[](2);
        uint256 epochIdx = order.epochIndex;
        uint256 epochsLen = epochs.length;
        uint256 value;
        while (epochIdx < epochsLen && (remainingDepositAmount > 0 || remainingRedeemShare > 0)) {
            EpochInfo memory epoch = epochs[epochIdx];
            if (remainingDepositAmount > 0 && epoch.depositFulfillment > 0) {
                value = remainingDepositAmount * epoch.depositFulfillment;
                payouts[0] += value / epoch.tokenPrice;
                remainingDepositAmount -= value;
            }
            if (remainingRedeemShare > 0 && epoch.redeemFulfillment > 0) {
                value = remainingRedeemShare * epoch.redeemFulfillment;
                payouts[1] += value * epoch.tokenPrice;
                remainingRedeemShare -= value;
            }
            epochIdx += 1;
        }
        newOrder.epochIndex = uint64(epochsLen);
        newOrder.depositAmount = uint96(remainingDepositAmount);
        newOrder.redeemShare = uint96(remainingRedeemShare);
    }
}
