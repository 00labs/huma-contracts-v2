// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IDealPortfolioPool} from "./IDealPortfolioPool.sol";

interface IEpochManagerLike {
    function epochIds()
        external
        view
        returns (uint256 currentEpochId, uint256 lastExecutedEpochId);
}

struct EpochOrder {
    uint96 totalDeposit;
    uint96 totalRedeemShare;
}

struct EpochInfo {
    uint96 depositFulfillment;
    uint96 redeemFulfillment;
    uint256 tokenPrice;
}

struct UserOrder {
    uint64 epochId;
    uint96 depositAmount;
    uint96 redeemShare;
}

contract TrancheVault is ERC20 {
    IDealPortfolioPool public portfolioPool;
    uint256 public index;

    IEpochManagerLike public epochManager;

    EpochOrder internal _epochOrder;
    mapping(uint256 => EpochInfo) public epochs;
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
        ei.tokenPrice = price;
        ei.depositFulfillment = uint96(data[1] / data[0]);
        ei.redeemFulfillment = uint96(data[3] / data[2]);
        epochs[epochId] = ei;

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
        (uint256 epochId, ) = epochManager.epochIds();
        order.epochId = uint64(epochId);
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
        (uint256 epochId, ) = epochManager.epochIds();
        order.epochId = uint64(epochId);
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
        (, uint256 endEpochId) = epochManager.epochIds();
        uint256 index = order.epochId;
        uint256 amount;
        while (index <= endEpochId && (remainingDepositAmount > 0 || remainingRedeemShare > 0)) {
            // if (remainingDepositAmount > 0) {
            //     amount = remainingDepositAmount, epochs[epochIdx].supplyFulfillment);
            //     // supply currency payout in token
            //     if (amount != 0) {
            //         payoutTokenAmount = safeAdd(
            //             payoutTokenAmount,
            //             safeDiv(safeMul(amount, ONE), epochs[epochIdx].tokenPrice)
            //         );
            //         remainingSupplyCurrency = safeSub(remainingSupplyCurrency, amount);
            //     }
            // }
            // if (remainingRedeemToken != 0) {
            //     amount = rmul(remainingRedeemToken, epochs[epochIdx].redeemFulfillment);
            //     // redeem token payout in currency
            //     if (amount != 0) {
            //         payoutCurrencyAmount = safeAdd(
            //             payoutCurrencyAmount,
            //             rmul(amount, epochs[epochIdx].tokenPrice)
            //         );
            //         remainingRedeemToken = safeSub(remainingRedeemToken, amount);
            //     }
            // }
            // epochIdx = safeAdd(epochIdx, 1);
        }
    }
}
