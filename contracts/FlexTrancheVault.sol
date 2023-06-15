// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {TrancheVault} from "./TrancheVault.sol";

struct FlexEpochOrder {
    uint96 requestedRedeemShare;
    uint96 submittedRedeemShare;
}

struct FlexEpochInfo {
    uint64 epochId;
    // the fullfillment ratio for flex redeem orders,
    // redeemFulfillment = (the processed redeem share / the submitted redeem share) * 1e18
    uint96 redeemFulfillment;
    uint256 sharePrice; // vault token share price when this flex epoch was processed
}

struct UserFlexOrder {
    uint64 epochIndex; // the max index of processed epoch array which was already consumed
    uint96 redeemShare; // the requested redeem share
}

contract FlexTrancheVault is TrancheVault {
    FlexEpochOrder internal _flexEpochOrder; // total order data of current flex epoch
    FlexEpochInfo[] public flexEpochs; // the processed epoch array
    mapping(address => UserFlexOrder) public flexOrders;

    constructor(string memory name_, string memory symbol_) TrancheVault(name_, symbol_) {}

    function flexEpochOrder() external view returns (uint256 submittedRedeemShare) {
        return _flexEpochOrder.submittedRedeemShare;
    }

    function submitFlexEpochOrder() external returns (uint256 submittedRedeemShare) {
        FlexEpochOrder memory feo = _flexEpochOrder;
        feo.submittedRedeemShare += feo.requestedRedeemShare;
        feo.requestedRedeemShare = 0;
        submittedRedeemShare = feo.submittedRedeemShare;
        _flexEpochOrder = feo;
    }

    function closeFlexEpoch(uint256 epochId, uint256 price, uint256[2] memory data) external {
        // check permission

        // create & store flex epoch info
        FlexEpochInfo memory fei;
        fei.epochId = uint64(epochId);
        fei.sharePrice = price;
        fei.redeemFulfillment = uint96(data[1] / data[0]);
        flexEpochs.push(fei);

        // withdraw from reserve
        // burn token

        FlexEpochOrder memory feo = _flexEpochOrder;

        // move remaining submitted redeem share to next flex epoch
        feo.submittedRedeemShare = feo.submittedRedeemShare - uint96(data[1] / price);
        _flexEpochOrder = feo;
    }

    // TODO it may require user to input principal amount and lock corresponding share instead to input share
    function makeFlexRedeemOrder(uint256 share) external {
        // check if this action is allowed
        _orderAllowed(msg.sender);

        UserFlexOrder memory fo = flexOrders[msg.sender];
        uint256 oldRedeemShare = fo.redeemShare;
        fo.redeemShare = uint96(share);

        // set the epoch index to the next processed epoch index
        fo.epochIndex = uint64(flexEpochs.length);
        flexOrders[msg.sender] = fo;

        // update total requested redeem share
        FlexEpochOrder memory feo = _flexEpochOrder;
        feo.requestedRedeemShare =
            feo.requestedRedeemShare -
            uint96(oldRedeemShare) +
            uint96(share);
        _flexEpochOrder = feo;

        // transfer delta from/to msg.sender
    }
}
