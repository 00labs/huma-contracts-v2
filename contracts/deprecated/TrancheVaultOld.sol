// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IDealPortfolioPool} from "../interfaces/IDealPortfolioPool.sol";

struct EpochOrderOld {
    uint96 totalDeposit; // total requested deposit underlying token amount of current epoch
    uint96 totalRedeemShare; // total requested redeem vault token share of current epoch
}

struct EpochInfoOld {
    uint64 epochId;
    // the fullfillment ratio for deposit orders,
    // depositFulfillment = (the processed deposit amount / the requested deposit amount) * 1e18
    uint96 depositFulfillment;
    // the fullfillment ratio for redeem orders,
    // redeemFulfillment = (the processed redeem share / the requested redeem share) * 1e18
    uint96 redeemFulfillment;
    uint256 sharePrice; // vault token share price when this epoch was processed
}

struct UserOrderOld {
    uint64 epochIndex; // the max index of processed epoch array which was already consumed
    uint96 depositAmount; // the requested deposit amount
    uint96 redeemShare; // the requested redeem share
}

/**
 * @notice TrancheVault provides functions of vault tokens for LP and functions of epoch management.
 */

contract TrancheVaultOld is ERC20 {
    IDealPortfolioPool public portfolioPool;
    uint256 public index; // senior index or junior index

    EpochOrderOld internal _epochOrder; // total order data of current epoch
    EpochInfoOld[] public epochs; // the processed epoch array
    mapping(address => UserOrderOld) public orders;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function totalAssets() public view returns (uint256) {
        return portfolioPool.trancheTotalAssets(index);
    }

    /**
     * @notice Returns total requested data.
     * @return totalDeposit total requested deposit amount
     * @return totalRedeemShare total requested redeem share
     */
    function epochOrder() external view returns (uint256 totalDeposit, uint256 totalRedeemShare) {
        EpochOrderOld memory eo = _epochOrder;
        totalDeposit = eo.totalDeposit;
        totalRedeemShare = eo.totalRedeemShare;
    }

    /**
     * @notice Updates epoch data
     * @param epochId epoch id
     * @param price vault share price when closing this epoch
     * @param data epoch data
     * data[0] - the requested deposit amount
     * data[1] - the processed deposit amount
     * data[2] - the requested redeem amount
     * data[3] - the processed redeem amount
     */
    function closeEpoch(uint256 epochId, uint256 price, uint256[4] memory data) external {
        // check permission

        // create & store epoch info
        EpochInfoOld memory ei;
        ei.epochId = uint64(epochId);
        ei.sharePrice = price;
        ei.depositFulfillment = uint96(data[1] / data[0]);
        ei.redeemFulfillment = uint96(data[3] / data[2]);
        epochs.push(ei);

        // deposit/withdraw from reserve
        // mint/burn token

        EpochOrderOld memory eo;

        // move remaining requested deposit amount and remaining requested redeem share to next epoch
        eo.totalDeposit = eo.totalDeposit - uint96(data[1]);
        eo.totalRedeemShare = eo.totalRedeemShare - uint96(data[3] / price);
        _epochOrder = eo;
    }

    /**
     * @notice Update the requested deposit amount
     * @param amount the requested deposit amount
     */
    function makeDepositOrder(uint256 amount) external {
        // check if this action is allowed
        _orderAllowed(msg.sender);

        UserOrderOld memory order = orders[msg.sender];
        uint256 oldDepositAmount = order.depositAmount;
        order.depositAmount = uint96(amount);

        // set the epoch index to the next processed epoch index
        order.epochIndex = uint64(epochs.length);
        orders[msg.sender] = order;

        // update total requested deposit amount
        EpochOrderOld memory eo = _epochOrder;
        eo.totalDeposit = eo.totalDeposit - uint96(oldDepositAmount) + uint96(amount);
        _epochOrder = eo;

        // transfer delta from/to msg.sender
    }

    /**
     * @notice Update the requested redeem share
     * @param share the requested redeem share
     */
    function makeRedeemOrder(uint256 share) external {
        // check if this action is allowed
        _orderAllowed(msg.sender);

        UserOrderOld memory order = orders[msg.sender];
        uint256 oldRedeemShare = order.redeemShare;
        order.redeemShare = uint96(share);

        // set the epoch index to the next processed epoch index
        order.epochIndex = uint64(epochs.length);
        orders[msg.sender] = order;

        // update total requested redeem share
        EpochOrderOld memory eo = _epochOrder;
        eo.totalRedeemShare = eo.totalRedeemShare - uint96(oldRedeemShare) + uint96(share);
        _epochOrder = eo;

        // transfer delta from/to msg.sender
    }

    /**
     * @notice Transfers processed underlying tokens or vault tokens to the user
     */
    function disburse() external {
        // check permissions

        UserOrderOld memory order = orders[msg.sender];

        uint256[] memory payouts;

        // calculate user's processed deposite amount and redeem share
        (payouts, order) = _calculateDisburse(order);

        // store remaining deposit amount and redeem share
        orders[msg.sender] = order;

        // disburse payouts
    }

    function _orderAllowed(address account) internal view {}

    /**
     * @notice Calculates the processed deposit amount and redeem share according to the user order data
     * @param order user order data
     * @return payouts payout data
     * payouts[0] - the vault token share for the processed deposit amount
     * payouts[1] - the underlying token amount for the processed redeem share
     * @return newOrder new user order data
     */
    function _calculateDisburse(
        UserOrderOld memory order
    ) internal view returns (uint256[] memory payouts, UserOrderOld memory newOrder) {
        uint256 remainingDepositAmount = order.depositAmount;
        uint256 remainingRedeemShare = order.redeemShare;
        payouts = new uint256[](2);

        // start from the unconsumed epoch index
        uint256 epochIdx = order.epochIndex;
        uint256 epochsLen = epochs.length;
        uint256 value;

        // iterate each unconsumed epoch to process user order
        while (epochIdx < epochsLen && (remainingDepositAmount > 0 || remainingRedeemShare > 0)) {
            EpochInfoOld memory epoch = epochs[epochIdx];

            // process deposit amount
            if (remainingDepositAmount > 0 && epoch.depositFulfillment > 0) {
                value = remainingDepositAmount * epoch.depositFulfillment;
                payouts[0] += value / epoch.sharePrice;
                remainingDepositAmount -= value;
            }

            // process redeem share
            if (remainingRedeemShare > 0 && epoch.redeemFulfillment > 0) {
                value = remainingRedeemShare * epoch.redeemFulfillment;
                payouts[1] += value * epoch.sharePrice;
                remainingRedeemShare -= value;
            }

            epochIdx += 1;
        }

        // prepare return data
        newOrder.epochIndex = uint64(epochsLen);
        newOrder.depositAmount = uint96(remainingDepositAmount);
        newOrder.redeemShare = uint96(remainingRedeemShare);
    }
}
