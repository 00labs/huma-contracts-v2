// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {HumaConfig} from "../../HumaConfig.sol";
import {IOldReceivableCredit} from "../interfaces/IOldReceivableCredit.sol";
import {IReceivable} from "../interfaces/IReceivable.sol";
import {ReceivableInput} from "../CreditStructs.sol";

//* Reserved for Richard review, to be deleted, please review this contract

contract SuperfluidProcessorStorage {
    struct SFReceivableInfo {
        address receivableAsset;
        uint96 receivableAmount;
        uint256 receivableParam;
    }

    HumaConfig public humaConfig;
    IOldReceivableCredit public receivableCredit;
    IReceivable public receivableAsset;

    /// mapping from wallet address to the receivable supplied by this wallet
    mapping(address => SFReceivableInfo) internal _sfReceivableInfoMapping;
    // Superfluid receivable parameter -> internal receivable id
    mapping(bytes32 => uint256) internal _sfReceivableParamInternalReceivableIdMapping;
    // Superfluid receivable id -> internal receivable id
    mapping(uint256 => uint256) internal _sfReceivableIdInternalReceivableIdMapping;

    struct StreamInfo {
        address borrower;
        uint96 flowrate;
        address superToken;
        uint64 lastStartTime;
        uint64 endTime;
        uint256 receivedFlowAmount;
        bytes32 flowKey; //the keccak256 hash of the Super token address and flowId
    }

    address public host;
    address public cfa;
    address public tradableStream;

    /// The mapping from the keccak256 hash of the flow to StreamInfo including
    /// the borrower address. This is needed for us to locate the borrower using
    /// the received receivable asset.
    // todo why isn't it bytes32?
    mapping(uint256 => StreamInfo) internal _streamInfoMapping;

    /// The mapping from the keccak256 hash of the flow to to the flow end time
    mapping(bytes32 => uint256) internal _flowEndMapping;

    bool internal _internalCall;

    uint256[100] private __gap;
}
